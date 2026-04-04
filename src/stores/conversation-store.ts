import { create } from "zustand";

import * as bridge from "../lib/bridge";
import type {
  ApprovalResponseInput,
  ComposerMentionBindingInput,
  ConversationComposerSettings,
  EnvironmentCapabilitiesSnapshot,
  SubmitPlanDecisionInput,
  ThreadConversationSnapshot,
} from "../lib/types";
import { useWorkspaceStore } from "./workspace-store";

function refreshWorkspaceSnapshotNonBlocking() {
  void useWorkspaceStore.getState().refreshSnapshot().catch(() => undefined);
}

type ConversationState = {
  snapshotsByThreadId: Record<string, ThreadConversationSnapshot>;
  capabilitiesByEnvironmentId: Record<string, EnvironmentCapabilitiesSnapshot>;
  composerByThreadId: Record<string, ConversationComposerSettings>;
  loadingByThreadId: Record<string, boolean>;
  errorByThreadId: Record<string, string | null>;
  listenerReady: boolean;

  initializeListener: () => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  refreshThread: (threadId: string) => Promise<void>;
  updateComposer: (
    threadId: string,
    patch: Partial<ConversationComposerSettings>,
  ) => void;
  sendMessage: (
    threadId: string,
    text: string,
    mentionBindings?: ComposerMentionBindingInput[],
  ) => Promise<boolean>;
  interruptThread: (threadId: string) => Promise<void>;
  respondToApprovalRequest: (
    threadId: string,
    interactionId: string,
    response: ApprovalResponseInput,
  ) => Promise<void>;
  respondToUserInputRequest: (
    threadId: string,
    interactionId: string,
    answers: Record<string, string[]>,
  ) => Promise<void>;
  submitPlanDecision: (
    input: SubmitPlanDecisionInput,
  ) => Promise<boolean>;
};

let unlistenConversationEvents: null | (() => void) = null;
let listenerInitialization: Promise<void> | null = null;
let listenerGeneration = 0;

export const useConversationStore = create<ConversationState>((set, get) => ({
  snapshotsByThreadId: {},
  capabilitiesByEnvironmentId: {},
  composerByThreadId: {},
  loadingByThreadId: {},
  errorByThreadId: {},
  listenerReady: false,

  initializeListener: async () => {
    if (get().listenerReady) return;
    if (listenerInitialization) {
      await listenerInitialization;
      return;
    }

    const generation = listenerGeneration;
    const initialization = bridge
      .listenToConversationEvents((payload) => {
        set((state) => ({
          snapshotsByThreadId: {
            ...state.snapshotsByThreadId,
            [payload.threadId]: payload.snapshot,
          },
          capabilitiesByEnvironmentId: state.capabilitiesByEnvironmentId,
          composerByThreadId: state.composerByThreadId[payload.threadId]
            ? state.composerByThreadId
            : {
                ...state.composerByThreadId,
                [payload.threadId]: payload.snapshot.composer,
              },
          loadingByThreadId: {
            ...state.loadingByThreadId,
            [payload.threadId]: false,
          },
          errorByThreadId: {
            ...state.errorByThreadId,
            [payload.threadId]: null,
          },
        }));
      })
      .then((unlisten) => {
        if (generation !== listenerGeneration) {
          unlisten();
          return;
        }
        unlistenConversationEvents = unlisten;
        set({ listenerReady: true });
      });
    listenerInitialization = initialization;

    try {
      await initialization;
    } finally {
      if (listenerInitialization === initialization) {
        listenerInitialization = null;
      }
    }
  },

  openThread: async (threadId) => {
    if (get().loadingByThreadId[threadId]) return;
    set((state) => ({
      loadingByThreadId: { ...state.loadingByThreadId, [threadId]: true },
      errorByThreadId: { ...state.errorByThreadId, [threadId]: null },
    }));
    try {
      const response = await bridge.openThreadConversation(threadId);
      set((state) => ({
        snapshotsByThreadId: {
          ...state.snapshotsByThreadId,
          [threadId]: response.snapshot,
        },
        capabilitiesByEnvironmentId: {
          ...state.capabilitiesByEnvironmentId,
          [response.capabilities.environmentId]: response.capabilities,
        },
        composerByThreadId: {
          ...state.composerByThreadId,
          [threadId]: response.snapshot.composer,
        },
        loadingByThreadId: { ...state.loadingByThreadId, [threadId]: false },
      }));
      await useWorkspaceStore.getState().refreshSnapshot();
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to open conversation";
      set((state) => ({
        loadingByThreadId: { ...state.loadingByThreadId, [threadId]: false },
        errorByThreadId: { ...state.errorByThreadId, [threadId]: message },
      }));
    }
  },

  refreshThread: async (threadId) => {
    try {
      const snapshot = await bridge.refreshThreadConversation(threadId);
      set((state) => ({
        snapshotsByThreadId: {
          ...state.snapshotsByThreadId,
          [threadId]: snapshot,
        },
        errorByThreadId: { ...state.errorByThreadId, [threadId]: null },
      }));
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to refresh conversation";
      set((state) => ({
        errorByThreadId: { ...state.errorByThreadId, [threadId]: message },
      }));
    }
  },

  updateComposer: (threadId, patch) =>
    set((state) => {
      const baseComposer =
        state.composerByThreadId[threadId] ?? state.snapshotsByThreadId[threadId]?.composer;
      if (!baseComposer) {
        return state;
      }

      return {
        composerByThreadId: {
          ...state.composerByThreadId,
          [threadId]: {
            ...baseComposer,
            ...patch,
          },
        },
      };
    }),

  sendMessage: async (threadId, text, mentionBindings = []) => {
    set((state) => ({
      errorByThreadId: { ...state.errorByThreadId, [threadId]: null },
    }));
    const composer =
      get().composerByThreadId[threadId] ??
      get().snapshotsByThreadId[threadId]?.composer;
    try {
      const snapshot = await bridge.sendThreadMessage({
        threadId,
        text,
        composer,
        ...(mentionBindings.length > 0 ? { mentionBindings } : {}),
      });
      set((state) => ({
        snapshotsByThreadId: {
          ...state.snapshotsByThreadId,
          [threadId]: snapshot,
        },
        composerByThreadId: {
          ...state.composerByThreadId,
          [threadId]: snapshot.composer,
        },
      }));
      refreshWorkspaceSnapshotNonBlocking();
      return true;
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to send message";
      set((state) => ({
        errorByThreadId: { ...state.errorByThreadId, [threadId]: message },
      }));
      return false;
    }
  },

  interruptThread: async (threadId) => {
    try {
      const snapshot = await bridge.interruptThreadTurn(threadId);
      set((state) => ({
        snapshotsByThreadId: {
          ...state.snapshotsByThreadId,
          [threadId]: snapshot,
        },
      }));
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to stop the active turn";
      set((state) => ({
        errorByThreadId: { ...state.errorByThreadId, [threadId]: message },
      }));
    }
  },

  respondToApprovalRequest: async (threadId, interactionId, response) => {
    set((state) => ({
      errorByThreadId: { ...state.errorByThreadId, [threadId]: null },
    }));
    try {
      const snapshot = await bridge.respondToApprovalRequest({
        threadId,
        interactionId,
        response,
      });
      set((state) => ({
        snapshotsByThreadId: {
          ...state.snapshotsByThreadId,
          [threadId]: snapshot,
        },
      }));
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to answer the approval request";
      set((state) => ({
        errorByThreadId: { ...state.errorByThreadId, [threadId]: message },
      }));
    }
  },

  respondToUserInputRequest: async (threadId, interactionId, answers) => {
    set((state) => ({
      errorByThreadId: { ...state.errorByThreadId, [threadId]: null },
    }));
    try {
      const snapshot = await bridge.respondToUserInputRequest({
        threadId,
        interactionId,
        answers,
      });
      set((state) => ({
        snapshotsByThreadId: {
          ...state.snapshotsByThreadId,
          [threadId]: snapshot,
        },
      }));
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to submit the requested answers";
      set((state) => ({
        errorByThreadId: { ...state.errorByThreadId, [threadId]: message },
      }));
    }
  },

  submitPlanDecision: async (input) => {
    set((state) => ({
      errorByThreadId: { ...state.errorByThreadId, [input.threadId]: null },
    }));
    try {
      const snapshot = await bridge.submitPlanDecision(input);
      set((state) => ({
        snapshotsByThreadId: {
          ...state.snapshotsByThreadId,
          [input.threadId]: snapshot,
        },
        composerByThreadId: {
          ...state.composerByThreadId,
          [input.threadId]: snapshot.composer,
        },
      }));
      refreshWorkspaceSnapshotNonBlocking();
      return true;
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to continue from the proposed plan";
      set((state) => ({
        errorByThreadId: { ...state.errorByThreadId, [input.threadId]: message },
      }));
      return false;
    }
  },
}));

export function selectConversationSnapshot(threadId: string | null) {
  return (state: ConversationState) =>
    (threadId ? state.snapshotsByThreadId[threadId] : null) ?? null;
}

export function selectConversationComposer(threadId: string | null) {
  return (state: ConversationState) =>
    (threadId ? state.composerByThreadId[threadId] : null) ??
    (threadId ? state.snapshotsByThreadId[threadId]?.composer : null) ??
    null;
}

export function selectConversationCapabilities(
  environmentId: string | null,
) {
  return (state: ConversationState) =>
    (environmentId ? state.capabilitiesByEnvironmentId[environmentId] : null) ?? null;
}

export function selectConversationError(threadId: string | null) {
  return (state: ConversationState) =>
    (threadId ? state.errorByThreadId[threadId] : null) ?? null;
}

export function teardownConversationListener() {
  listenerGeneration += 1;
  unlistenConversationEvents?.();
  unlistenConversationEvents = null;
  listenerInitialization = null;
  useConversationStore.setState({ listenerReady: false });
}
