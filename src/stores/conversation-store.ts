import { create } from "zustand";

import * as bridge from "../lib/bridge";
import type {
  ApprovalResponseInput,
  ComposerMentionBindingInput,
  ConversationComposerDraft,
  ConversationComposerSettings,
  ConversationImageAttachment,
  ConversationMessageItem,
  EnvironmentCapabilitiesSnapshot,
  SubmitPlanDecisionInput,
  ThreadConversationSnapshot,
} from "../lib/types";
import {
  clearThreadDraftPersistence,
  clearDraftPersistenceControllers,
  draftForThread,
  hydrateDraftEntry,
  EMPTY_CONVERSATION_COMPOSER_DRAFT,
  normalizeDraft,
  persistenceModeForDraftChange,
  removeDraftEntry,
  sameDraft,
  scheduleDraftPersistence,
  setDraftEntry,
  type DraftPersistenceMode,
  type DraftUpdate,
} from "./conversation-drafts";
import {
  requestWorkspaceRefresh,
} from "./workspace-store";

type ConversationSet = (
  updater: (state: ConversationState) => Partial<ConversationState>,
) => void;

type ConversationGet = () => ConversationState;

type OpenThreadOptions = {
  skipIfLoaded?: boolean;
};

export type ThreadHydrationState = "cold" | "loading" | "ready" | "error";

type ConversationState = {
  snapshotsByThreadId: Record<string, ThreadConversationSnapshot>;
  capabilitiesByEnvironmentId: Record<string, EnvironmentCapabilitiesSnapshot>;
  composerByThreadId: Record<string, ConversationComposerSettings>;
  draftByThreadId: Record<string, ConversationComposerDraft>;
  hydrationByThreadId: Record<string, ThreadHydrationState>;
  errorByThreadId: Record<string, string | null>;
  listenerReady: boolean;

  initializeListener: () => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  refreshThread: (threadId: string) => Promise<void>;
  updateComposer: (
    threadId: string,
    patch: Partial<ConversationComposerSettings>,
  ) => void;
  updateDraft: (threadId: string, update: DraftUpdate) => void;
  replaceDraftLocally: (
    threadId: string,
    draft: ConversationComposerDraft | null,
  ) => void;
  resetDraft: (threadId: string) => void;
  sendMessage: (
    threadId: string,
    text: string,
    images?: ConversationImageAttachment[],
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
  submitPlanDecision: (input: SubmitPlanDecisionInput) => Promise<boolean>;
};

type ConversationStateData = Pick<
  ConversationState,
  | "snapshotsByThreadId"
  | "capabilitiesByEnvironmentId"
  | "composerByThreadId"
  | "draftByThreadId"
  | "hydrationByThreadId"
  | "errorByThreadId"
  | "listenerReady"
>;

export const INITIAL_CONVERSATION_STATE: ConversationStateData = {
  snapshotsByThreadId: {},
  capabilitiesByEnvironmentId: {},
  composerByThreadId: {},
  draftByThreadId: {},
  hydrationByThreadId: {},
  errorByThreadId: {},
  listenerReady: false,
};

let unlistenConversationEvents: null | (() => void) = null;
let listenerInitialization: Promise<void> | null = null;
let listenerGeneration = 0;
const inflightThreadLoads = new Map<string, Promise<boolean>>();

function refreshWorkspaceSnapshotNonBlocking() {
  requestWorkspaceRefresh();
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  ...INITIAL_CONVERSATION_STATE,

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
          hydrationByThreadId: {
            ...state.hydrationByThreadId,
            [payload.threadId]: "ready",
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
    await openThreadWithOptions(get, set, threadId, {
      skipIfLoaded: true,
    });
  },

  refreshThread: async (threadId) => {
    try {
      const snapshot = await bridge.refreshThreadConversation(threadId);
      set((state) => ({
        snapshotsByThreadId: {
          ...state.snapshotsByThreadId,
          [threadId]: snapshot,
        },
        hydrationByThreadId: {
          ...state.hydrationByThreadId,
          [threadId]: "ready",
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

  updateDraft: (threadId, update) => {
    let nextDraft: ConversationComposerDraft | null = null;
    let persistenceMode: DraftPersistenceMode | null = null;

    set((state) => {
      const currentDraft = draftForThread(state.draftByThreadId, threadId);
      const updatedDraft =
        typeof update === "function"
          ? normalizeDraft(update(normalizeDraft(currentDraft)))
          : normalizeDraft({
              ...currentDraft,
              ...update,
            });

      if (sameDraft(currentDraft, updatedDraft)) {
        return state;
      }

      nextDraft = updatedDraft;
      persistenceMode = persistenceModeForDraftChange(currentDraft, updatedDraft);
      return {
        draftByThreadId: setDraftEntry(state.draftByThreadId, threadId, updatedDraft),
      };
    });

    if (nextDraft && persistenceMode) {
      scheduleDraftPersistence(threadId, nextDraft, persistenceMode);
    }
  },

  replaceDraftLocally: (threadId, draft) =>
    set((state) => ({
      draftByThreadId: setDraftEntry(state.draftByThreadId, threadId, draft),
    })),

  resetDraft: (threadId) => {
    set((state) => ({
      draftByThreadId: setDraftEntry(state.draftByThreadId, threadId, null),
    }));
    scheduleDraftPersistence(
      threadId,
      EMPTY_CONVERSATION_COMPOSER_DRAFT,
      "immediate",
    );
  },

  sendMessage: async (threadId, text, images = [], mentionBindings = []) => {
    set((state) => ({
      errorByThreadId: { ...state.errorByThreadId, [threadId]: null },
    }));
    const composer =
      get().composerByThreadId[threadId] ??
      get().snapshotsByThreadId[threadId]?.composer;
    const previousSnapshot = get().snapshotsByThreadId[threadId];
    const optimisticMessage = previousSnapshot
      ? buildOptimisticUserMessageSnapshot(previousSnapshot, text, images)
      : null;

    if (optimisticMessage) {
      set((state) => ({
        snapshotsByThreadId: {
          ...state.snapshotsByThreadId,
          [threadId]: optimisticMessage.snapshot,
        },
      }));
    }

    try {
      const snapshot = await bridge.sendThreadMessage({
        threadId,
        text,
        composer,
        ...(images.length > 0 ? { images } : {}),
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
        draftByThreadId: removeDraftEntry(state.draftByThreadId, threadId),
      }));
      clearThreadDraftPersistence(threadId);
      refreshWorkspaceSnapshotNonBlocking();
      return true;
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to send message";
      set((state) => ({
        snapshotsByThreadId:
          optimisticMessage &&
          previousSnapshot &&
          snapshotContainsItem(
            state.snapshotsByThreadId[threadId],
            optimisticMessage.itemId,
          )
            ? {
                ...state.snapshotsByThreadId,
                [threadId]: previousSnapshot,
              }
            : state.snapshotsByThreadId,
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
        draftByThreadId: removeDraftEntry(state.draftByThreadId, input.threadId),
      }));
      clearThreadDraftPersistence(input.threadId);
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

export function selectConversationDraft(threadId: string | null) {
  return (state: ConversationState) =>
    (threadId ? state.draftByThreadId[threadId] : null) ??
    EMPTY_CONVERSATION_COMPOSER_DRAFT;
}

export function selectConversationHydration(threadId: string | null) {
  return (state: ConversationState) =>
    (threadId ? state.hydrationByThreadId[threadId] : null) ?? "cold";
}

export function selectConversationCapabilities(environmentId: string | null) {
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
  inflightThreadLoads.clear();
  clearDraftPersistenceControllers();
  useConversationStore.setState({ listenerReady: false });
}

async function openThreadWithOptions(
  get: ConversationGet,
  set: ConversationSet,
  threadId: string,
  options: OpenThreadOptions,
): Promise<boolean> {
  if (options.skipIfLoaded && restoreHydratedThreadIfPresent(get, set, threadId)) {
    return false;
  }

  const inflight = inflightThreadLoads.get(threadId);
  if (inflight) {
    return inflight;
  }

  const loadPromise = (async () => {
    if (options.skipIfLoaded && restoreHydratedThreadIfPresent(get, set, threadId)) {
      return false;
    }

    set((state) => ({
      hydrationByThreadId: {
        ...state.hydrationByThreadId,
        [threadId]: "loading",
      },
      errorByThreadId: { ...state.errorByThreadId, [threadId]: null },
    }));

    try {
      const response = await bridge.openThreadConversation(threadId);
      set((state) => {
        return {
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
          draftByThreadId: hydrateDraftEntry(
            state.draftByThreadId,
            threadId,
            response.composerDraft,
          ),
          hydrationByThreadId: {
            ...state.hydrationByThreadId,
            [threadId]: "ready",
          },
        };
      });

      return true;
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to open conversation";
      set((state) => ({
        hydrationByThreadId: {
          ...state.hydrationByThreadId,
          [threadId]: "error",
        },
        errorByThreadId: { ...state.errorByThreadId, [threadId]: message },
      }));
      return false;
    }
  })();

  inflightThreadLoads.set(threadId, loadPromise);
  try {
    return await loadPromise;
  } finally {
    if (inflightThreadLoads.get(threadId) === loadPromise) {
      inflightThreadLoads.delete(threadId);
    }
  }
}

function buildOptimisticUserMessageSnapshot(
  snapshot: ThreadConversationSnapshot,
  text: string,
  images: ConversationImageAttachment[],
): {
  itemId: string;
  snapshot: ThreadConversationSnapshot;
} | null {
  if (text.length === 0 && images.length === 0) {
    return null;
  }

  const messageItem: ConversationMessageItem = {
    kind: "message",
    id: `optimistic-user-${crypto.randomUUID()}`,
    role: "user",
    text,
    images: images.length > 0 ? images : null,
    isStreaming: false,
  };

  return {
    itemId: messageItem.id,
    snapshot: {
      ...snapshot,
      items: [...snapshot.items, messageItem],
      error: null,
    },
  };
}

function snapshotContainsItem(
  snapshot: ThreadConversationSnapshot | undefined,
  itemId: string,
): boolean {
  return snapshot?.items.some((item) => item.id === itemId) ?? false;
}

function restoreHydratedThreadIfPresent(
  get: ConversationGet,
  set: ConversationSet,
  threadId: string,
) {
  const state = get();
  const snapshot = state.snapshotsByThreadId[threadId];
  if (!snapshot || !state.capabilitiesByEnvironmentId[snapshot.environmentId]) {
    return false;
  }

  if (
    state.hydrationByThreadId[threadId] !== "ready" ||
    state.errorByThreadId[threadId] !== null
  ) {
    set((currentState) => ({
      hydrationByThreadId: {
        ...currentState.hydrationByThreadId,
        [threadId]: "ready",
      },
      errorByThreadId: {
        ...currentState.errorByThreadId,
        [threadId]: null,
      },
    }));
  }

  return true;
}
