import * as bridge from "../lib/bridge";
import type {
  ComposerDraftMentionBinding,
  ConversationComposerDraft,
  ConversationImageAttachment,
} from "../lib/types";

const DRAFT_PERSIST_DEBOUNCE_MS = 250;
const DRAFT_PERSIST_RETRY_MS = 1000;

export const EMPTY_CONVERSATION_COMPOSER_DRAFT: ConversationComposerDraft = {
  text: "",
  images: [],
  mentionBindings: [],
  isRefiningPlan: false,
};

export type DraftEntries = Record<string, ConversationComposerDraft>;
export type DraftPersistenceMode = "debounced" | "immediate";
export type DraftUpdate =
  | Partial<ConversationComposerDraft>
  | ((draft: ConversationComposerDraft) => ConversationComposerDraft);

type DraftPersistenceController = {
  epoch: number;
  inflight: Promise<void> | null;
  lastPersistedKey: string | null | undefined;
  queued: ConversationComposerDraft | null | undefined;
  timeoutId: ReturnType<typeof setTimeout> | null;
};

const draftPersistenceByThreadId = new Map<string, DraftPersistenceController>();

export function hydrateDraftEntry(
  draftByThreadId: DraftEntries,
  threadId: string,
  draft: ConversationComposerDraft | null | undefined,
) {
  if (draft == null || draftByThreadId[threadId] || isEmptyDraft(draft)) {
    return draftByThreadId;
  }

  const nextDraft = normalizeDraft(draft);

  return {
    ...draftByThreadId,
    [threadId]: nextDraft,
  };
}

export function draftForThread(draftByThreadId: DraftEntries, threadId: string) {
  return draftByThreadId[threadId] ?? EMPTY_CONVERSATION_COMPOSER_DRAFT;
}

export function normalizeDraft(draft: ConversationComposerDraft): ConversationComposerDraft {
  return {
    text: draft.text,
    images: [...draft.images],
    mentionBindings: [...draft.mentionBindings],
    isRefiningPlan: draft.isRefiningPlan,
  };
}

export function isEmptyDraft(draft: ConversationComposerDraft | null | undefined) {
  return (
    draft == null ||
    (draft.text.length === 0 &&
      draft.images.length === 0 &&
      draft.mentionBindings.length === 0 &&
      !draft.isRefiningPlan)
  );
}

export function sameDraft(
  left: ConversationComposerDraft,
  right: ConversationComposerDraft,
) {
  return (
    left.text === right.text &&
    sameImageAttachments(left.images, right.images) &&
    sameMentionBindings(left.mentionBindings, right.mentionBindings) &&
    left.isRefiningPlan === right.isRefiningPlan
  );
}

export function persistenceModeForDraftChange(
  currentDraft: ConversationComposerDraft,
  nextDraft: ConversationComposerDraft,
): DraftPersistenceMode {
  if (
    !sameImageAttachments(currentDraft.images, nextDraft.images) ||
    !sameMentionBindings(currentDraft.mentionBindings, nextDraft.mentionBindings) ||
    currentDraft.isRefiningPlan !== nextDraft.isRefiningPlan
  ) {
    return "immediate";
  }

  return currentDraft.text === nextDraft.text ? "immediate" : "debounced";
}

export function setDraftEntry(
  draftByThreadId: DraftEntries,
  threadId: string,
  draft: ConversationComposerDraft | null,
) {
  if (draft == null || isEmptyDraft(draft)) {
    return removeDraftEntry(draftByThreadId, threadId);
  }

  return {
    ...draftByThreadId,
    [threadId]: normalizeDraft(draft),
  };
}

export function removeDraftEntry(draftByThreadId: DraftEntries, threadId: string) {
  if (!draftByThreadId[threadId]) {
    return draftByThreadId;
  }

  const nextDraftByThreadId = { ...draftByThreadId };
  delete nextDraftByThreadId[threadId];
  return nextDraftByThreadId;
}

export function clearDraftPersistenceControllers() {
  for (const controller of draftPersistenceByThreadId.values()) {
    if (controller.timeoutId) {
      clearTimeout(controller.timeoutId);
    }
  }
  draftPersistenceByThreadId.clear();
}

export function clearThreadDraftPersistence(threadId: string) {
  const controller = draftPersistenceByThreadId.get(threadId);
  if (!controller) {
    return;
  }

  controller.epoch += 1;
  controller.queued = null;

  if (controller.timeoutId) {
    clearTimeout(controller.timeoutId);
    controller.timeoutId = null;
  }

  if (!controller.inflight) {
    void flushDraftPersistence(threadId);
  }
}

export function scheduleDraftPersistence(
  threadId: string,
  draft: ConversationComposerDraft,
  mode: DraftPersistenceMode,
) {
  const controller = ensureDraftPersistenceController(threadId);
  controller.queued = isEmptyDraft(draft) ? null : normalizeDraft(draft);

  if (controller.timeoutId) {
    clearTimeout(controller.timeoutId);
    controller.timeoutId = null;
  }

  if (mode === "debounced") {
    controller.timeoutId = setTimeout(() => {
      controller.timeoutId = null;
      void flushDraftPersistence(threadId);
    }, DRAFT_PERSIST_DEBOUNCE_MS);
    return;
  }

  void flushDraftPersistence(threadId);
}

function ensureDraftPersistenceController(threadId: string) {
  const existing = draftPersistenceByThreadId.get(threadId);
  if (existing) {
    return existing;
  }

  const controller: DraftPersistenceController = {
    epoch: 0,
    inflight: null,
    lastPersistedKey: undefined,
    queued: undefined,
    timeoutId: null,
  };
  draftPersistenceByThreadId.set(threadId, controller);
  return controller;
}

async function flushDraftPersistence(threadId: string) {
  const controller = ensureDraftPersistenceController(threadId);
  if (controller.inflight || controller.queued === undefined) {
    return;
  }

  const draft = controller.queued;
  const nextKey = draftPersistenceKey(draft);
  const epoch = controller.epoch;
  if (controller.lastPersistedKey === nextKey) {
    controller.queued = undefined;
    maybeDisposeDraftPersistenceController(threadId);
    return;
  }

  controller.queued = undefined;
  controller.inflight = (async () => {
    try {
      await bridge.saveThreadComposerDraft({
        threadId,
        draft,
      });
      if (epoch === controller.epoch) {
        controller.lastPersistedKey = nextKey;
      }
    } catch {
      if (controller.queued === undefined) {
        controller.queued = draft;
      }
      scheduleDraftRetry(threadId, controller);
      return;
    } finally {
      controller.inflight = null;
    }

    if (
      controller.queued !== undefined &&
      draftPersistenceKey(controller.queued) !== controller.lastPersistedKey
    ) {
      void flushDraftPersistence(threadId);
      return;
    }

    maybeDisposeDraftPersistenceController(threadId);
  })();

  await controller.inflight;
}

function maybeDisposeDraftPersistenceController(threadId: string) {
  const controller = draftPersistenceByThreadId.get(threadId);
  if (!controller) {
    return;
  }
  if (controller.inflight || controller.timeoutId || controller.queued !== undefined) {
    return;
  }
  if (controller.lastPersistedKey === undefined) {
    return;
  }
  draftPersistenceByThreadId.delete(threadId);
}

function scheduleDraftRetry(
  threadId: string,
  controller: DraftPersistenceController,
) {
  if (controller.timeoutId) {
    return;
  }

  controller.timeoutId = setTimeout(() => {
    controller.timeoutId = null;
    void flushDraftPersistence(threadId);
  }, DRAFT_PERSIST_RETRY_MS);
}

function draftPersistenceKey(draft: ConversationComposerDraft | null | undefined) {
  if (draft === undefined) {
    return undefined;
  }
  if (isEmptyDraft(draft)) {
    return null;
  }
  return JSON.stringify(draft);
}

function sameImageAttachments(
  left: ConversationImageAttachment[],
  right: ConversationImageAttachment[],
) {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((attachment, index) => sameImageAttachment(attachment, right[index])))
  );
}

function sameImageAttachment(
  left: ConversationImageAttachment,
  right: ConversationImageAttachment | undefined,
) {
  return (
    right !== undefined &&
    left.type === right.type &&
    (left.type === "image"
      ? right.type === "image" && left.url === right.url
      : right.type === "localImage" && left.path === right.path)
  );
}

function sameMentionBindings(
  left: ComposerDraftMentionBinding[],
  right: ComposerDraftMentionBinding[],
) {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((binding, index) => sameMentionBinding(binding, right[index])))
  );
}

function sameMentionBinding(
  left: ComposerDraftMentionBinding,
  right: ComposerDraftMentionBinding | undefined,
) {
  return (
    right !== undefined &&
    left.mention === right.mention &&
    left.kind === right.kind &&
    left.path === right.path &&
    left.start === right.start &&
    left.end === right.end
  );
}
