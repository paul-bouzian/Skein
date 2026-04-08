import { create } from "zustand";

import * as bridge from "../lib/bridge";
import type {
  ApprovalResponseInput,
  ConversationImageAttachment,
  ConversationMessageItem,
  ComposerMentionBindingInput,
  ConversationComposerSettings,
  EnvironmentCapabilitiesSnapshot,
  SubmitPlanDecisionInput,
  ThreadConversationSnapshot,
  WorkspaceSnapshot,
} from "../lib/types";
import { useWorkspaceStore } from "./workspace-store";

const PRELOAD_ENVIRONMENT_CONCURRENCY = 4;

function refreshWorkspaceSnapshotNonBlocking() {
  void useWorkspaceStore.getState().refreshSnapshot().catch(() => undefined);
}

type ConversationSet = (
  updater: (state: ConversationState) => Partial<ConversationState>,
) => void;

type ConversationGet = () => ConversationState;

type OpenThreadOptions = {
  refreshWorkspace?: boolean;
  skipIfLoaded?: boolean;
};

type ConversationState = {
  snapshotsByThreadId: Record<string, ThreadConversationSnapshot>;
  capabilitiesByEnvironmentId: Record<string, EnvironmentCapabilitiesSnapshot>;
  composerByThreadId: Record<string, ConversationComposerSettings>;
  loadingByThreadId: Record<string, boolean>;
  errorByThreadId: Record<string, string | null>;
  listenerReady: boolean;

  initializeListener: () => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  preloadActiveThreads: () => Promise<void>;
  refreshThread: (threadId: string) => Promise<void>;
  updateComposer: (
    threadId: string,
    patch: Partial<ConversationComposerSettings>,
  ) => void;
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
  submitPlanDecision: (
    input: SubmitPlanDecisionInput,
  ) => Promise<boolean>;
};

let unlistenConversationEvents: null | (() => void) = null;
let listenerInitialization: Promise<void> | null = null;
let listenerGeneration = 0;
let preloadActiveThreadsPromise: Promise<void> | null = null;
const inflightThreadLoads = new Map<string, Promise<boolean>>();

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
    await openThreadWithOptions(get, set, threadId, {
      refreshWorkspace: true,
      skipIfLoaded: true,
    });
  },

  preloadActiveThreads: async () => {
    if (preloadActiveThreadsPromise) {
      await preloadActiveThreadsPromise;
      return;
    }

    const task = preloadAllActiveThreads(get, set);
    preloadActiveThreadsPromise = task;

    try {
      await task;
    } finally {
      if (preloadActiveThreadsPromise === task) {
        preloadActiveThreadsPromise = null;
      }
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
      }));
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
  preloadActiveThreadsPromise = null;
  inflightThreadLoads.clear();
  useConversationStore.setState({ listenerReady: false });
}

async function preloadAllActiveThreads(
  get: ConversationGet,
  set: ConversationSet,
): Promise<void> {
  const snapshot = useWorkspaceStore.getState().snapshot;
  if (!snapshot) {
    return;
  }

  const targets = collectEnvironmentPreloadTargets(snapshot);
  if (targets.length === 0) {
    return;
  }

  let shouldRefreshWorkspace = false;
  await runWithConcurrency(
    targets,
    PRELOAD_ENVIRONMENT_CONCURRENCY,
    async (target) => {
      for (const threadId of target.threadIds) {
        const opened = await openThreadWithOptions(get, set, threadId, {
          refreshWorkspace: false,
          skipIfLoaded: true,
        });
        shouldRefreshWorkspace = shouldRefreshWorkspace || opened;
      }
    },
  );

  if (shouldRefreshWorkspace) {
    await useWorkspaceStore.getState().refreshSnapshot();
  }
}

async function openThreadWithOptions(
  get: ConversationGet,
  set: ConversationSet,
  threadId: string,
  options: OpenThreadOptions,
): Promise<boolean> {
  if (options.skipIfLoaded && isThreadHydrated(get(), threadId)) {
    return false;
  }

  const inflight = inflightThreadLoads.get(threadId);
  if (inflight) {
    return inflight;
  }

  const loadPromise = (async () => {
    if (options.skipIfLoaded && isThreadHydrated(get(), threadId)) {
      return false;
    }

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

      if (options.refreshWorkspace !== false) {
        await useWorkspaceStore.getState().refreshSnapshot();
      }

      return true;
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to open conversation";
      set((state) => ({
        loadingByThreadId: { ...state.loadingByThreadId, [threadId]: false },
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

function isThreadHydrated(
  state: Pick<
    ConversationState,
    "capabilitiesByEnvironmentId" | "snapshotsByThreadId"
  >,
  threadId: string,
) {
  const snapshot = state.snapshotsByThreadId[threadId];
  return Boolean(
    snapshot && state.capabilitiesByEnvironmentId[snapshot.environmentId],
  );
}

function collectEnvironmentPreloadTargets(snapshot: WorkspaceSnapshot) {
  return snapshot.projects
    .flatMap((project) =>
      project.environments.map((environment) => ({
        environmentId: environment.id,
        isRunning: environment.runtime.state === "running",
        threadIds: [...environment.threads]
          .filter((thread) => thread.status === "active")
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .map((thread) => thread.id),
      })),
    )
    .filter((environment) => environment.threadIds.length > 0)
    .sort(
      (left, right) =>
        Number(right.isRunning) - Number(left.isRunning) ||
        left.environmentId.localeCompare(right.environmentId),
    );
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
) {
  let index = 0;
  const concurrency = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        await worker(item);
      }
    }),
  );
}
