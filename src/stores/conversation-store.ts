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
  ThreadRecord,
  ThreadConversationSnapshot,
  WorkspaceSnapshot,
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
  useWorkspaceStore,
} from "./workspace-store";

type ConversationSet = (
  updater: (state: ConversationState) => Partial<ConversationState>,
) => void;

type ConversationGet = () => ConversationState;

type OpenThreadOptions = {
  skipIfLoaded?: boolean;
};

export type ThreadHydrationState = "cold" | "loading" | "ready" | "error";
export type RuntimeHydrationState = "cold" | "loading" | "ready" | "error";

export type PendingFirstMessage = {
  text: string;
  images: ConversationImageAttachment[];
  mentionBindings: ComposerMentionBindingInput[];
  composer: ConversationComposerSettings | null;
};

type ConversationState = {
  snapshotsByThreadId: Record<string, ThreadConversationSnapshot>;
  capabilitiesByEnvironmentId: Record<string, EnvironmentCapabilitiesSnapshot>;
  composerByThreadId: Record<string, ConversationComposerSettings>;
  draftByThreadId: Record<string, ConversationComposerDraft>;
  hydrationByThreadId: Record<string, ThreadHydrationState>;
  runtimeHydrationByThreadId: Record<string, RuntimeHydrationState>;
  errorByThreadId: Record<string, string | null>;
  pendingFirstMessageByThreadId: Record<string, PendingFirstMessage>;
  listenerReady: boolean;

  initializeListener: () => Promise<void>;
  tryLoadEnvironmentCapabilities: (
    environmentId: string,
  ) => Promise<EnvironmentCapabilitiesSnapshot | null>;
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
  enqueuePendingFirstMessage: (
    threadId: string,
    payload: PendingFirstMessage,
  ) => void;
  stagePendingFirstMessage: (
    thread: ThreadRecord,
    payload: PendingFirstMessage,
  ) => void;
  cancelPendingFirstMessage: (threadId: string) => PendingFirstMessage | null;
  consumePendingFirstMessage: (threadId: string) => PendingFirstMessage | null;
};

type ConversationStateData = Pick<
  ConversationState,
  | "snapshotsByThreadId"
  | "capabilitiesByEnvironmentId"
  | "composerByThreadId"
  | "draftByThreadId"
  | "hydrationByThreadId"
  | "runtimeHydrationByThreadId"
  | "errorByThreadId"
  | "pendingFirstMessageByThreadId"
  | "listenerReady"
>;

export const INITIAL_CONVERSATION_STATE: ConversationStateData = {
  snapshotsByThreadId: {},
  capabilitiesByEnvironmentId: {},
  composerByThreadId: {},
  draftByThreadId: {},
  hydrationByThreadId: {},
  runtimeHydrationByThreadId: {},
  errorByThreadId: {},
  pendingFirstMessageByThreadId: {},
  listenerReady: false,
};

function runtimeHydrationReadyPatch(
  state: ConversationState,
  threadId: string,
): Pick<ConversationStateData, "runtimeHydrationByThreadId" | "errorByThreadId"> {
  return {
    runtimeHydrationByThreadId: {
      ...state.runtimeHydrationByThreadId,
      [threadId]: "ready",
    },
    errorByThreadId: {
      ...state.errorByThreadId,
      [threadId]: null,
    },
  };
}

let unlistenConversationEvents: null | (() => void) = null;
let listenerInitialization: Promise<void> | null = null;
let listenerGeneration = 0;
const inflightThreadLoads = new Map<string, Promise<boolean>>();
const inflightEnvironmentCapabilityLoads = new Map<
  string,
  Promise<EnvironmentCapabilitiesSnapshot | null>
>();
type PendingOptimisticUserMessage = {
  item: ConversationMessageItem;
  afterItemId: string | null;
  baseItemCount: number;
};
const pendingOptimisticUserMessages = new Map<
  string,
  PendingOptimisticUserMessage
>();
export const OPTIMISTIC_FIRST_TURN_ID = "optimistic-first-turn";
const BACKFILL_DELAY_MS = 1_500;
const projectionBackfillQueuesByEnvironment = new Map<string, string[]>();
const projectionBackfillTimersByEnvironment = new Map<string, number>();
const projectionBackfillRunningEnvironmentIds = new Set<string>();

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
        const snapshot = snapshotWithPendingOptimisticMessage(
          payload.threadId,
          payload.snapshot,
        );
        set((state) => ({
          snapshotsByThreadId: {
            ...state.snapshotsByThreadId,
            [payload.threadId]: snapshot,
          },
          capabilitiesByEnvironmentId: state.capabilitiesByEnvironmentId,
          composerByThreadId: state.composerByThreadId[payload.threadId]
            ? state.composerByThreadId
            : {
                ...state.composerByThreadId,
                [payload.threadId]: snapshot.composer,
              },
          hydrationByThreadId: {
            ...state.hydrationByThreadId,
            [payload.threadId]: "ready",
          },
          ...runtimeHydrationReadyPatch(state, payload.threadId),
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

  tryLoadEnvironmentCapabilities: async (environmentId) => {
    const trimmedEnvironmentId = environmentId.trim();
    if (!trimmedEnvironmentId) {
      return null;
    }

    const cached =
      get().capabilitiesByEnvironmentId[trimmedEnvironmentId] ?? null;
    if (cached) {
      return cached;
    }

    const inflight =
      inflightEnvironmentCapabilityLoads.get(trimmedEnvironmentId) ?? null;
    if (inflight) {
      return inflight;
    }

    const loadPromise = bridge
      .getEnvironmentCapabilities(trimmedEnvironmentId)
      .then((capabilities) => {
        set((state) => ({
          capabilitiesByEnvironmentId: {
            ...state.capabilitiesByEnvironmentId,
            [capabilities.environmentId]: capabilities,
          },
        }));
        return capabilities;
      })
      .catch(() => null);

    inflightEnvironmentCapabilityLoads.set(trimmedEnvironmentId, loadPromise);
    try {
      return await loadPromise;
    } finally {
      if (
        inflightEnvironmentCapabilityLoads.get(trimmedEnvironmentId) ===
        loadPromise
      ) {
        inflightEnvironmentCapabilityLoads.delete(trimmedEnvironmentId);
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
      const snapshot = snapshotWithPendingOptimisticMessage(
        threadId,
        await bridge.refreshThreadConversation(threadId),
      );
      set((state) => ({
        snapshotsByThreadId: {
          ...state.snapshotsByThreadId,
          [threadId]: snapshot,
        },
        hydrationByThreadId: {
          ...state.hydrationByThreadId,
          [threadId]: "ready",
        },
        ...runtimeHydrationReadyPatch(state, threadId),
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
    const stagedOptimisticMessage = previousSnapshot
      ? reusablePendingOptimisticUserMessage(
          threadId,
          text,
          images,
          mentionBindings,
          previousSnapshot,
        )
      : null;
    const optimisticMessage =
      previousSnapshot && !stagedOptimisticMessage
        ? buildOptimisticUserMessageSnapshot(
            previousSnapshot,
            text,
            images,
            mentionBindings,
          )
        : null;
    const rollbackSnapshot =
      stagedOptimisticMessage && previousSnapshot
        ? snapshotWithoutItem(previousSnapshot, stagedOptimisticMessage.item.id)
        : previousSnapshot;

    if (optimisticMessage) {
      pendingOptimisticUserMessages.set(threadId, {
        item: optimisticMessage.item,
        afterItemId:
          previousSnapshot.items[previousSnapshot.items.length - 1]?.id ?? null,
        baseItemCount: previousSnapshot.items.length,
      });
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
      const nextSnapshot = snapshotWithPendingOptimisticMessage(
        threadId,
        snapshot,
      );
      set((state) => {
        const existingSnapshot = state.snapshotsByThreadId[threadId];
        const shouldKeepExisting =
          existingSnapshot !== undefined &&
          existingSnapshot.items.length > nextSnapshot.items.length;
        const storedSnapshot = shouldKeepExisting
          ? existingSnapshot
          : nextSnapshot;
        return {
          snapshotsByThreadId: {
            ...state.snapshotsByThreadId,
            [threadId]: storedSnapshot,
          },
          composerByThreadId: {
            ...state.composerByThreadId,
            [threadId]: storedSnapshot.composer,
          },
          draftByThreadId: removeDraftEntry(state.draftByThreadId, threadId),
          ...runtimeHydrationReadyPatch(state, threadId),
        };
      });
      clearThreadDraftPersistence(threadId);
      refreshWorkspaceSnapshotNonBlocking();
      return true;
    } catch (cause: unknown) {
      pendingOptimisticUserMessages.delete(threadId);
      const message =
        cause instanceof Error ? cause.message : "Failed to send message";
      set((state) => ({
        snapshotsByThreadId:
          (optimisticMessage || stagedOptimisticMessage) &&
          rollbackSnapshot &&
          snapshotContainsItem(
            state.snapshotsByThreadId[threadId],
            (optimisticMessage ?? stagedOptimisticMessage)!.item.id,
          )
            ? {
                ...state.snapshotsByThreadId,
                [threadId]: rollbackSnapshot,
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
        ...runtimeHydrationReadyPatch(state, threadId),
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
        ...runtimeHydrationReadyPatch(state, threadId),
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
        ...runtimeHydrationReadyPatch(state, threadId),
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
        ...runtimeHydrationReadyPatch(state, input.threadId),
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

  enqueuePendingFirstMessage: (threadId, payload) =>
    set((state) => ({
      pendingFirstMessageByThreadId: {
        ...state.pendingFirstMessageByThreadId,
        [threadId]: payload,
      },
    })),

  stagePendingFirstMessage: (thread, payload) => {
    const optimisticItem = createOptimisticUserMessage(
      payload.text,
      payload.images,
      payload.mentionBindings,
    );
    if (!optimisticItem || !payload.composer) {
      get().enqueuePendingFirstMessage(thread.id, payload);
      return;
    }
    const composer = payload.composer;
    const baseSnapshot =
      get().snapshotsByThreadId[thread.id] ??
      buildPendingFirstMessageSnapshot(thread, composer);

    pendingOptimisticUserMessages.set(thread.id, {
      item: optimisticItem,
      afterItemId: baseSnapshot.items[baseSnapshot.items.length - 1]?.id ?? null,
      baseItemCount: baseSnapshot.items.length,
    });

    set((state) => {
      return {
        snapshotsByThreadId: {
          ...state.snapshotsByThreadId,
          [thread.id]: snapshotWithPendingOptimisticMessage(
            thread.id,
            baseSnapshot,
          ),
        },
        composerByThreadId: {
          ...state.composerByThreadId,
          [thread.id]: composer,
        },
        hydrationByThreadId: {
          ...state.hydrationByThreadId,
          [thread.id]: "ready",
        },
        runtimeHydrationByThreadId: {
          ...state.runtimeHydrationByThreadId,
          [thread.id]: "loading",
        },
        errorByThreadId: { ...state.errorByThreadId, [thread.id]: null },
        pendingFirstMessageByThreadId: {
          ...state.pendingFirstMessageByThreadId,
          [thread.id]: payload,
        },
      };
    });
  },

  cancelPendingFirstMessage: (threadId) => {
    const pendingFirstMessage = get().pendingFirstMessageByThreadId[threadId] ?? null;
    if (!pendingFirstMessage) return null;

    const pendingOptimisticMessage =
      pendingOptimisticUserMessages.get(threadId) ?? null;
    pendingOptimisticUserMessages.delete(threadId);

    set((state) => {
      const nextPendingFirstMessages = {
        ...state.pendingFirstMessageByThreadId,
      };
      delete nextPendingFirstMessages[threadId];

      const currentSnapshot = state.snapshotsByThreadId[threadId];
      const nextSnapshot =
        pendingOptimisticMessage && currentSnapshot
          ? snapshotWithoutItem(currentSnapshot, pendingOptimisticMessage.item.id)
          : currentSnapshot;

      return {
        pendingFirstMessageByThreadId: nextPendingFirstMessages,
        snapshotsByThreadId:
          nextSnapshot && nextSnapshot !== currentSnapshot
            ? {
                ...state.snapshotsByThreadId,
                [threadId]: nextSnapshot,
              }
            : state.snapshotsByThreadId,
      };
    });

    return pendingFirstMessage;
  },

  consumePendingFirstMessage: (threadId) => {
    const pending = get().pendingFirstMessageByThreadId[threadId] ?? null;
    if (!pending) return null;
    set((state) => {
      if (!(threadId in state.pendingFirstMessageByThreadId)) return state;
      const next = { ...state.pendingFirstMessageByThreadId };
      delete next[threadId];
      return { pendingFirstMessageByThreadId: next };
    });
    return pending;
  },
}));

export function selectPendingFirstMessage(threadId: string | null) {
  return (state: ConversationState) =>
    (threadId ? state.pendingFirstMessageByThreadId[threadId] : null) ?? null;
}

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

export function selectConversationRuntimeHydration(threadId: string | null) {
  return (state: ConversationState) =>
    (threadId ? state.runtimeHydrationByThreadId[threadId] : null) ?? "cold";
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
  inflightEnvironmentCapabilityLoads.clear();
  pendingOptimisticUserMessages.clear();
  for (const timer of projectionBackfillTimersByEnvironment.values()) {
    window.clearTimeout(timer);
  }
  projectionBackfillQueuesByEnvironment.clear();
  projectionBackfillTimersByEnvironment.clear();
  projectionBackfillRunningEnvironmentIds.clear();
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
        [threadId]: state.snapshotsByThreadId[threadId] ? "ready" : "loading",
      },
      runtimeHydrationByThreadId: {
        ...state.runtimeHydrationByThreadId,
        [threadId]: "loading",
      },
      errorByThreadId: { ...state.errorByThreadId, [threadId]: null },
    }));

    try {
      const localSnapshot = await bridge
        .getThreadConversationSnapshot(threadId)
        .catch(() => null);
      if (localSnapshot) {
        set((state) => {
          const existingSnapshot = state.snapshotsByThreadId[threadId];
          const shouldKeepExisting =
            existingSnapshot !== undefined &&
            existingSnapshot.items.length > localSnapshot.items.length;
          const nextSnapshot = shouldKeepExisting
            ? existingSnapshot
            : localSnapshot;
          const reconciledSnapshot = snapshotWithPendingOptimisticMessage(
            threadId,
            nextSnapshot,
          );
          return {
            snapshotsByThreadId: {
              ...state.snapshotsByThreadId,
              [threadId]: reconciledSnapshot,
            },
            hydrationByThreadId: {
              ...state.hydrationByThreadId,
              [threadId]: "ready",
            },
          };
        });
      }

      const response = await bridge.openThreadConversation(threadId);
      set((state) => {
        // The bridge call can race with live snapshot events and in-flight
        // optimistic updates (the listener and `sendMessage` both write to
        // `snapshotsByThreadId`). If the store already holds a snapshot with
        // more items than the one the bridge just returned, keep the newer
        // one — otherwise we'd overwrite an optimistic user message with an
        // empty snapshot the backend fetched before the send landed.
        const existingSnapshot = state.snapshotsByThreadId[threadId];
        const shouldKeepExisting =
          existingSnapshot !== undefined &&
          existingSnapshot.items.length > response.snapshot.items.length;
        const nextSnapshot = shouldKeepExisting
          ? existingSnapshot
          : response.snapshot;
        const reconciledSnapshot = snapshotWithPendingOptimisticMessage(
          threadId,
          nextSnapshot,
        );
        return {
          snapshotsByThreadId: {
            ...state.snapshotsByThreadId,
            [threadId]: reconciledSnapshot,
          },
          capabilitiesByEnvironmentId: {
            ...state.capabilitiesByEnvironmentId,
            [response.capabilities.environmentId]: response.capabilities,
          },
          // Preserve composer settings the caller may have seeded (e.g. the
          // draft composer's model / effort / fast-mode choice before the
          // thread was created).
          composerByThreadId: state.composerByThreadId[threadId]
            ? state.composerByThreadId
            : {
                ...state.composerByThreadId,
                [threadId]: reconciledSnapshot.composer,
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
          ...runtimeHydrationReadyPatch(state, threadId),
        };
      });

      return true;
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to open conversation";
      set((state) => ({
        hydrationByThreadId: {
          ...state.hydrationByThreadId,
          [threadId]: state.snapshotsByThreadId[threadId] ? "ready" : "error",
        },
        runtimeHydrationByThreadId: {
          ...state.runtimeHydrationByThreadId,
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
  mentionBindings: ComposerMentionBindingInput[],
): {
  item: ConversationMessageItem;
  snapshot: ThreadConversationSnapshot;
} | null {
  const messageItem = createOptimisticUserMessage(
    text,
    images,
    mentionBindings,
  );
  if (!messageItem) return null;

  return {
    item: messageItem,
    snapshot: {
      ...snapshot,
      items: [...snapshot.items, messageItem],
      error: null,
    },
  };
}

function createOptimisticUserMessage(
  text: string,
  images: ConversationImageAttachment[],
  mentionBindings: ComposerMentionBindingInput[] = [],
): ConversationMessageItem | null {
  if (text.length === 0 && images.length === 0) {
    return null;
  }

  return {
    kind: "message",
    id: `optimistic-user-${crypto.randomUUID()}`,
    role: "user",
    text,
    images: images.length > 0 ? images : null,
    mentionBindings: mentionBindings.length > 0 ? mentionBindings : null,
    isStreaming: false,
  };
}

function buildPendingFirstMessageSnapshot(
  thread: ThreadRecord,
  composer: ThreadConversationSnapshot["composer"],
): ThreadConversationSnapshot {
  return {
    threadId: thread.id,
    environmentId: thread.environmentId,
    provider: thread.provider,
    providerThreadId: thread.providerThreadId ?? null,
    codexThreadId: thread.codexThreadId ?? null,
    hiddenProviderMessageIds: [],
    hiddenProviderMessageTexts: [],
    status: "running",
    activeTurnId: OPTIMISTIC_FIRST_TURN_ID,
    items: [],
    subagents: [],
    tokenUsage: null,
    pendingInteractions: [],
    proposedPlan: null,
    taskPlan: null,
    error: null,
    composer,
  };
}

function reusablePendingOptimisticUserMessage(
  threadId: string,
  text: string,
  images: ConversationImageAttachment[],
  mentionBindings: ComposerMentionBindingInput[],
  snapshot: ThreadConversationSnapshot,
): PendingOptimisticUserMessage | null {
  const pending = pendingOptimisticUserMessages.get(threadId);
  if (!pending || !snapshotContainsItem(snapshot, pending.item.id)) {
    return null;
  }
  if (pending.item.text !== text) {
    return null;
  }
  if (!sameImageAttachments(pending.item.images ?? null, images)) {
    return null;
  }
  if (
    !sameMentionBindingInputs(
      pending.item.mentionBindings ?? [],
      mentionBindings,
    )
  ) {
    return null;
  }
  return pending;
}

function snapshotWithoutItem(
  snapshot: ThreadConversationSnapshot,
  itemId: string,
): ThreadConversationSnapshot {
  const nextItems = snapshot.items.filter((item) => item.id !== itemId);
  if (snapshot.activeTurnId === OPTIMISTIC_FIRST_TURN_ID) {
    return {
      ...snapshot,
      status: "idle",
      activeTurnId: null,
      items: nextItems,
    };
  }
  return {
    ...snapshot,
    items: nextItems,
  };
}

function snapshotWithPendingOptimisticMessage(
  threadId: string,
  snapshot: ThreadConversationSnapshot,
): ThreadConversationSnapshot {
  const pending = pendingOptimisticUserMessages.get(threadId);
  if (!pending) {
    return snapshot;
  }

  const confirmedIndex = findConfirmedUserMessageIndex(snapshot, pending);
  if (confirmedIndex !== -1) {
    pendingOptimisticUserMessages.delete(threadId);
    return {
      ...snapshot,
      items: snapshot.items.flatMap((item, index) => {
        if (item.id === pending.item.id) {
          return [];
        }
        if (
          index === confirmedIndex &&
          item.kind === "message" &&
          !item.mentionBindings?.length &&
          pending.item.mentionBindings?.length
        ) {
          return [{ ...item, mentionBindings: pending.item.mentionBindings }];
        }
        return [item];
      }),
    };
  }

  if (snapshotContainsItem(snapshot, pending.item.id)) {
    return isStalePreRunSnapshot(snapshot)
      ? snapshotWithOptimisticTurn(snapshot)
      : snapshot;
  }

  const afterIndex = pending.afterItemId
    ? snapshot.items.findIndex((item) => item.id === pending.afterItemId)
    : -1;
  const insertAt =
    afterIndex >= 0
      ? afterIndex + 1
      : Math.min(pending.baseItemCount, snapshot.items.length);

  return {
    ...snapshotWithOptimisticTurn(snapshot),
    items: [
      ...snapshot.items.slice(0, insertAt),
      pending.item,
      ...snapshot.items.slice(insertAt),
    ],
    error: null,
  };
}

function isStalePreRunSnapshot(snapshot: ThreadConversationSnapshot): boolean {
  return snapshot.status === "idle" && !snapshot.activeTurnId;
}

function snapshotWithOptimisticTurn(
  snapshot: ThreadConversationSnapshot,
): ThreadConversationSnapshot {
  if (!isStalePreRunSnapshot(snapshot)) {
    return snapshot;
  }
  return {
    ...snapshot,
    status: "running",
    activeTurnId: OPTIMISTIC_FIRST_TURN_ID,
    error: null,
  };
}

function findConfirmedUserMessageIndex(
  snapshot: ThreadConversationSnapshot,
  pending: PendingOptimisticUserMessage,
): number {
  const anchorIndex = pending.afterItemId
    ? snapshot.items.findIndex((item) => item.id === pending.afterItemId)
    : -1;
  const searchStart = anchorIndex >= 0
    ? anchorIndex + 1
    : Math.min(pending.baseItemCount, snapshot.items.length);
  const relativeIndex = snapshot.items.slice(searchStart).findIndex(
    (item) =>
      item.kind === "message" &&
      item.id !== pending.item.id &&
      item.role === "user" &&
      item.text === pending.item.text &&
      sameImageAttachments(item.images ?? null, pending.item.images ?? null),
  );
  return relativeIndex === -1 ? -1 : searchStart + relativeIndex;
}

function sameMentionBindingInputs(
  left: ComposerMentionBindingInput[],
  right: ComposerMentionBindingInput[],
) {
  return (
    left.length === right.length &&
    left.every((binding, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        binding.mention === other.mention &&
        binding.kind === other.kind &&
        binding.path === other.path
      );
    })
  );
}

function sameImageAttachments(
  left: ConversationImageAttachment[] | null,
  right: ConversationImageAttachment[] | null,
): boolean {
  if (!left?.length && !right?.length) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => {
    const other = right[index];
    if (!other) {
      return false;
    }
    if (item.type !== other.type) {
      // Local uploads can be rewritten to provider-hosted image URLs by the runtime.
      return true;
    }
    if (item.type === "image" && other.type === "image") {
      return item.url === other.url;
    }
    return item.type === "localImage" && other.type === "localImage"
      ? item.path === other.path
      : false;
  });
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

  if (state.hydrationByThreadId[threadId] !== "ready") {
    set((currentState) => ({
      hydrationByThreadId: {
        ...currentState.hydrationByThreadId,
        [threadId]: "ready",
      },
    }));
  }

  return (
    state.runtimeHydrationByThreadId[threadId] === "ready" &&
    (state.errorByThreadId[threadId] ?? null) === null
  );
}

function enqueueProjectionBackfill(snapshot: WorkspaceSnapshot | null) {
  if (!snapshot) return;
  const conversationState = useConversationStore.getState();
  const environments = [
    ...snapshot.projects.flatMap((project) => project.environments),
    ...snapshot.chat.environments,
  ];
  for (const environment of environments) {
    const candidates = environment.threads
      .filter((thread) => thread.providerThreadId || thread.codexThreadId)
      .filter((thread) => {
        if (conversationState.runtimeHydrationByThreadId[thread.id] === "error") {
          return false;
        }
        const existing = conversationState.snapshotsByThreadId[thread.id];
        return !existing || existing.items.length === 0;
      })
      .map((thread) => thread.id);
    if (candidates.length === 0) continue;

    const queue = projectionBackfillQueuesByEnvironment.get(environment.id) ?? [];
    for (const threadId of candidates) {
      if (!queue.includes(threadId)) {
        queue.push(threadId);
      }
    }
    projectionBackfillQueuesByEnvironment.set(environment.id, queue);
    scheduleProjectionBackfill(environment.id);
  }
}

function scheduleProjectionBackfill(environmentId: string) {
  if (projectionBackfillTimersByEnvironment.has(environmentId)) return;
  const timer = window.setTimeout(() => {
    projectionBackfillTimersByEnvironment.delete(environmentId);
    void drainProjectionBackfillQueue(environmentId);
  }, BACKFILL_DELAY_MS);
  projectionBackfillTimersByEnvironment.set(environmentId, timer);
}

async function drainProjectionBackfillQueue(environmentId: string) {
  if (projectionBackfillRunningEnvironmentIds.has(environmentId)) return;
  projectionBackfillRunningEnvironmentIds.add(environmentId);
  try {
    while (true) {
      const queue = projectionBackfillQueuesByEnvironment.get(environmentId) ?? [];
      const threadId = queue.shift();
      if (!threadId) {
        projectionBackfillQueuesByEnvironment.delete(environmentId);
        return;
      }
      projectionBackfillQueuesByEnvironment.set(environmentId, queue);
      const state = useConversationStore.getState();
      if (state.runtimeHydrationByThreadId[threadId] === "error") {
        continue;
      }
      const snapshot = state.snapshotsByThreadId[threadId];
      if (snapshot && snapshot.items.length > 0) {
        continue;
      }
      await openThreadWithOptions(
        () => useConversationStore.getState(),
        (updater) => useConversationStore.setState((current) => updater(current)),
        threadId,
        { skipIfLoaded: true },
      );
    }
  } finally {
    projectionBackfillRunningEnvironmentIds.delete(environmentId);
    if ((projectionBackfillQueuesByEnvironment.get(environmentId)?.length ?? 0) > 0) {
      scheduleProjectionBackfill(environmentId);
    }
  }
}

useWorkspaceStore.subscribe((state, previousState) => {
  if (state.snapshot !== previousState.snapshot) {
    enqueueProjectionBackfill(state.snapshot);
  }
});
