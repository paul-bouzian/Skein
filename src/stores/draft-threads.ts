import * as bridge from "../lib/bridge";
import type {
  DraftProjectSelection,
  DraftThreadTarget,
  GlobalSettings,
  SavedDraftThreadState,
} from "../lib/types";
import {
  EMPTY_CONVERSATION_COMPOSER_DRAFT,
  normalizeDraft,
  sameDraft,
} from "./conversation-drafts";

const DRAFT_THREAD_PERSIST_DEBOUNCE_MS = 250;
const DRAFT_THREAD_PERSIST_RETRY_MS = 1000;

export type DraftThreadEntries = Record<string, SavedDraftThreadState>;
export type DraftThreadHydrationEntries = Record<
  string,
  "cold" | "loading" | "ready" | "error"
>;
export type DraftThreadPersistenceMode = "debounced" | "immediate";

type DraftThreadPersistenceController = {
  afterPersistCallbacks: Array<{
    callback: () => void;
    minPersistGeneration: number;
  }>;
  epoch: number;
  inflight: Promise<void> | null;
  inflightGeneration: number | null;
  lastPersistedKey: string | null | undefined;
  persistGeneration: number;
  queued: SavedDraftThreadState | null | undefined;
  timeoutId: ReturnType<typeof setTimeout> | null;
};

type DraftThreadMovePersistenceController = {
  destinationKey: string;
  epoch: number;
  sourceKeys: string[];
  sources: DraftThreadTarget[];
};

const draftThreadPersistenceByKey = new Map<
  string,
  DraftThreadPersistenceController
>();
const draftThreadMovePersistenceByKey = new Map<
  string,
  DraftThreadMovePersistenceController
>();
const draftThreadMoveEpochByKey = new Map<string, number>();

export function draftThreadTargetKey(target: DraftThreadTarget) {
  return target.kind === "chat" ? "chat" : `project:${target.projectId}`;
}

export function composerFromSettings(settings: GlobalSettings) {
  return {
    provider: settings.defaultProvider,
    model: settings.defaultModel,
    reasoningEffort: settings.defaultReasoningEffort,
    collaborationMode: settings.defaultCollaborationMode,
    approvalPolicy: settings.defaultApprovalPolicy,
    serviceTier: settings.defaultServiceTier ?? null,
  };
}

export function defaultDraftThreadState(
  target: DraftThreadTarget,
  settings: GlobalSettings,
): SavedDraftThreadState {
  return {
    composerDraft: normalizeDraft(EMPTY_CONVERSATION_COMPOSER_DRAFT),
    composer: composerFromSettings(settings),
    projectSelection:
      target.kind === "project"
        ? ({
            kind: "local",
          } satisfies DraftProjectSelection)
        : null,
  };
}

export function normalizeDraftThreadState(
  target: DraftThreadTarget,
  state: SavedDraftThreadState,
): SavedDraftThreadState {
  return {
    composerDraft: normalizeDraft(state.composerDraft),
    composer: { ...state.composer },
    projectSelection: normalizeProjectSelection(target, state.projectSelection ?? null),
  };
}

export function persistedDraftThreadState(
  target: DraftThreadTarget,
  state: SavedDraftThreadState,
  settings: GlobalSettings,
) {
  return sameDraftThreadState(state, defaultDraftThreadState(target, settings))
    ? null
    : normalizeDraftThreadState(target, state);
}

export function sameDraftThreadState(
  left: SavedDraftThreadState,
  right: SavedDraftThreadState,
) {
  return (
    sameDraft(left.composerDraft, right.composerDraft) &&
    sameComposer(left.composer, right.composer) &&
    sameProjectSelection(left.projectSelection ?? null, right.projectSelection ?? null)
  );
}

export function persistenceModeForDraftThreadChange(
  current: SavedDraftThreadState,
  next: SavedDraftThreadState,
): DraftThreadPersistenceMode {
  if (isTextOnlyDraftThreadChange(current, next) || isNewWorktreeNameOnlyChange(current, next)) {
    return "debounced";
  }

  return "immediate";
}

export function scheduleDraftThreadPersistence(
  target: DraftThreadTarget,
  state: SavedDraftThreadState | null,
  mode: DraftThreadPersistenceMode,
) {
  const key = draftThreadTargetKey(target);
  clearDraftThreadMovePersistenceForSourceKey(key);
  const controller = ensureDraftThreadPersistenceController(key);
  controller.queued = state == null ? null : normalizeDraftThreadState(target, state);

  if (controller.timeoutId) {
    clearTimeout(controller.timeoutId);
    controller.timeoutId = null;
  }

  if (mode === "debounced") {
    controller.timeoutId = setTimeout(() => {
      controller.timeoutId = null;
      void flushDraftThreadPersistence(target);
    }, DRAFT_THREAD_PERSIST_DEBOUNCE_MS);
    return;
  }

  void flushDraftThreadPersistence(target);
}

export function scheduleDraftThreadMovePersistence(
  source: DraftThreadTarget,
  destination: DraftThreadTarget,
  destinationState: SavedDraftThreadState | null,
) {
  const sourceKey = draftThreadTargetKey(source);
  const destinationKey = draftThreadTargetKey(destination);
  if (sourceKey === destinationKey) {
    scheduleDraftThreadPersistence(destination, destinationState, "immediate");
    return;
  }

  clearDraftThreadPersistenceByKey(sourceKey);
  const sources = uniqueDraftThreadTargets([
    ...takeDraftThreadMoveSourcesForDestinationKey(sourceKey),
    source,
  ]);
  clearDraftThreadMovePersistenceForSourceKey(sourceKey);
  clearDraftThreadMovePersistenceForSourceKey(destinationKey);

  const moveKey = draftThreadMovePersistenceKey(sourceKey, destinationKey);
  const epoch = nextDraftThreadMoveEpoch(moveKey);
  const controller: DraftThreadMovePersistenceController = {
    destinationKey,
    epoch,
    sourceKeys: sources.map(draftThreadTargetKey),
    sources,
  };
  draftThreadMovePersistenceByKey.set(moveKey, controller);
  enqueueDraftThreadPersistenceCallback(destinationKey, () => {
    if (!isActiveDraftThreadMovePersistence(moveKey, epoch)) {
      return;
    }
    for (const sourceTarget of sources) {
      scheduleDraftThreadPersistence(sourceTarget, null, "immediate");
    }
  });
  scheduleDraftThreadPersistence(destination, destinationState, "immediate");
}

export function clearDraftThreadPersistenceControllers() {
  for (const controller of draftThreadPersistenceByKey.values()) {
    if (controller.timeoutId) {
      clearTimeout(controller.timeoutId);
    }
  }
  draftThreadPersistenceByKey.clear();
  draftThreadMovePersistenceByKey.clear();
  draftThreadMoveEpochByKey.clear();
}

export function clearDraftThreadPersistence(target: DraftThreadTarget) {
  const key = draftThreadTargetKey(target);
  clearDraftThreadPersistenceByKey(key);
  clearDraftThreadMovePersistenceForSourceKey(key);
  clearDraftThreadMovePersistenceForDestinationKey(key);
}

export function clearInvalidDraftThreadPersistenceControllers(
  validKeys: ReadonlySet<string>,
) {
  for (const key of draftThreadPersistenceByKey.keys()) {
    if (!validKeys.has(key)) {
      clearDraftThreadPersistenceByKey(key);
    }
  }
  for (const [
    key,
    controller,
  ] of draftThreadMovePersistenceByKey.entries()) {
    if (
      controller.sourceKeys.some((sourceKey) => !validKeys.has(sourceKey)) ||
      !validKeys.has(controller.destinationKey)
    ) {
      clearDraftThreadMovePersistenceByKey(key);
    }
  }
}

function ensureDraftThreadPersistenceController(key: string) {
  const existing = draftThreadPersistenceByKey.get(key);
  if (existing) {
    return existing;
  }

  const controller: DraftThreadPersistenceController = {
    afterPersistCallbacks: [],
    epoch: 0,
    inflight: null,
    inflightGeneration: null,
    lastPersistedKey: undefined,
    persistGeneration: 0,
    queued: undefined,
    timeoutId: null,
  };
  draftThreadPersistenceByKey.set(key, controller);
  return controller;
}

function maybeDisposeDraftThreadPersistenceController(key: string) {
  const controller = draftThreadPersistenceByKey.get(key);
  if (!controller) {
    return;
  }
  if (
    controller.inflight === null &&
    controller.timeoutId === null &&
    controller.afterPersistCallbacks.length === 0 &&
    controller.queued === undefined
  ) {
    draftThreadPersistenceByKey.delete(key);
  }
}

function enqueueDraftThreadPersistenceCallback(
  key: string,
  callback: () => void,
) {
  const controller = ensureDraftThreadPersistenceController(key);
  controller.afterPersistCallbacks.push({
    callback,
    minPersistGeneration:
      controller.inflightGeneration == null
        ? controller.persistGeneration + 1
        : controller.inflightGeneration + 1,
  });
}

async function flushDraftThreadPersistence(target: DraftThreadTarget) {
  const key = draftThreadTargetKey(target);
  const controller = ensureDraftThreadPersistenceController(key);
  if (controller.inflight || controller.queued === undefined) {
    return;
  }

  const state = controller.queued;
  const nextKey = JSON.stringify(state);
  const epoch = controller.epoch;
  if (controller.lastPersistedKey === nextKey) {
    controller.queued = undefined;
    runDraftThreadPersistenceCallbacks(
      controller,
      Number.POSITIVE_INFINITY,
    );
    maybeDisposeDraftThreadPersistenceController(key);
    return;
  }

  const persistGeneration = controller.persistGeneration + 1;
  controller.persistGeneration = persistGeneration;
  controller.inflightGeneration = persistGeneration;
  controller.queued = undefined;
  controller.inflight = (async () => {
    try {
      await bridge.saveDraftThreadState({
        target,
        state,
      });
      if (epoch === controller.epoch) {
        controller.lastPersistedKey = nextKey;
        runDraftThreadPersistenceCallbacks(controller, persistGeneration);
      }
    } catch {
      if (epoch !== controller.epoch) {
        return;
      }
      if (controller.queued === undefined) {
        controller.queued = state;
      }
      scheduleDraftThreadRetry(target, controller);
      return;
    } finally {
      controller.inflight = null;
      controller.inflightGeneration = null;
    }

    if (controller.queued !== undefined) {
      if (JSON.stringify(controller.queued) !== controller.lastPersistedKey) {
        void flushDraftThreadPersistence(target);
        return;
      }

      controller.queued = undefined;
      runDraftThreadPersistenceCallbacks(
        controller,
        Number.POSITIVE_INFINITY,
      );
    }

    maybeDisposeDraftThreadPersistenceController(key);
  })();
}

function scheduleDraftThreadRetry(
  target: DraftThreadTarget,
  controller: DraftThreadPersistenceController,
) {
  if (controller.timeoutId) {
    return;
  }

  controller.timeoutId = setTimeout(() => {
    controller.timeoutId = null;
    void flushDraftThreadPersistence(target);
  }, DRAFT_THREAD_PERSIST_RETRY_MS);
}

function isActiveDraftThreadMovePersistence(moveKey: string, epoch: number) {
  const controller = draftThreadMovePersistenceByKey.get(moveKey);
  return controller !== undefined && controller.epoch === epoch;
}

function runDraftThreadPersistenceCallbacks(
  controller: DraftThreadPersistenceController,
  persistGeneration: number,
) {
  if (controller.afterPersistCallbacks.length === 0) {
    return;
  }
  const callbacksToRun = controller.afterPersistCallbacks.filter(
    ({ minPersistGeneration }) => minPersistGeneration <= persistGeneration,
  );
  controller.afterPersistCallbacks = controller.afterPersistCallbacks.filter(
    ({ minPersistGeneration }) => minPersistGeneration > persistGeneration,
  );
  for (const { callback } of callbacksToRun) {
    callback();
  }
}

function clearDraftThreadPersistenceByKey(key: string) {
  const controller = draftThreadPersistenceByKey.get(key);
  if (!controller) {
    return;
  }

  controller.epoch += 1;
  controller.queued = undefined;
  controller.afterPersistCallbacks = [];
  if (controller.timeoutId) {
    clearTimeout(controller.timeoutId);
    controller.timeoutId = null;
  }
  maybeDisposeDraftThreadPersistenceController(key);
}

function draftThreadMovePersistenceKey(sourceKey: string, destinationKey: string) {
  return `${sourceKey}\n${destinationKey}`;
}

function uniqueDraftThreadTargets(targets: DraftThreadTarget[]) {
  const byKey = new Map<string, DraftThreadTarget>();
  for (const target of targets) {
    byKey.set(draftThreadTargetKey(target), target);
  }
  return [...byKey.values()];
}

function nextDraftThreadMoveEpoch(moveKey: string) {
  const epoch = (draftThreadMoveEpochByKey.get(moveKey) ?? 0) + 1;
  draftThreadMoveEpochByKey.set(moveKey, epoch);
  return epoch;
}

function takeDraftThreadMoveSourcesForDestinationKey(destinationKey: string) {
  const sources: DraftThreadTarget[] = [];
  for (const [
    key,
    controller,
  ] of draftThreadMovePersistenceByKey.entries()) {
    if (controller.destinationKey === destinationKey) {
      sources.push(...controller.sources);
      clearDraftThreadMovePersistenceByKey(key);
    }
  }
  return sources;
}

function clearDraftThreadMovePersistenceForSourceKey(sourceKey: string) {
  for (const [
    key,
    controller,
  ] of draftThreadMovePersistenceByKey.entries()) {
    if (controller.sourceKeys.includes(sourceKey)) {
      clearDraftThreadMovePersistenceByKey(key);
    }
  }
}

function clearDraftThreadMovePersistenceForDestinationKey(destinationKey: string) {
  for (const [
    key,
    controller,
  ] of draftThreadMovePersistenceByKey.entries()) {
    if (controller.destinationKey === destinationKey) {
      clearDraftThreadMovePersistenceByKey(key);
    }
  }
}

function clearDraftThreadMovePersistenceByKey(key: string) {
  const controller = draftThreadMovePersistenceByKey.get(key);
  if (!controller) {
    return;
  }

  draftThreadMoveEpochByKey.set(
    key,
    Math.max(draftThreadMoveEpochByKey.get(key) ?? 0, controller.epoch) + 1,
  );
  draftThreadMovePersistenceByKey.delete(key);
}

function sameComposer(
  left: SavedDraftThreadState["composer"],
  right: SavedDraftThreadState["composer"],
) {
  return (
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.collaborationMode === right.collaborationMode &&
    left.approvalPolicy === right.approvalPolicy &&
    left.serviceTier === right.serviceTier
  );
}

function normalizeProjectSelection(
  target: DraftThreadTarget,
  selection: DraftProjectSelection | null,
): DraftProjectSelection | null {
  if (target.kind === "chat") {
    return null;
  }

  if (!selection) {
    return { kind: "local" };
  }

  switch (selection.kind) {
    case "local":
      return { kind: "local" };
    case "existing":
      return { kind: "existing", environmentId: selection.environmentId };
    case "new":
      return {
        kind: "new",
        baseBranch: selection.baseBranch,
        name: selection.name,
      };
  }
}

function sameProjectSelection(
  left: DraftProjectSelection | null,
  right: DraftProjectSelection | null,
) {
  if (left === right) {
    return true;
  }
  if (left == null || right == null) {
    return left == null && right == null;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "local":
      return true;
    case "existing":
      return right.kind === "existing" && left.environmentId === right.environmentId;
    case "new":
      return (
        right.kind === "new" &&
        left.baseBranch === right.baseBranch &&
        left.name === right.name
      );
  }
}

function isTextOnlyDraftThreadChange(
  current: SavedDraftThreadState,
  next: SavedDraftThreadState,
) {
  return (
    current.composerDraft.text !== next.composerDraft.text &&
    sameComposer(current.composer, next.composer) &&
    sameProjectSelection(current.projectSelection ?? null, next.projectSelection ?? null) &&
    current.composerDraft.isRefiningPlan === next.composerDraft.isRefiningPlan &&
    current.composerDraft.images.length === next.composerDraft.images.length &&
    current.composerDraft.images.every(
      (attachment, index) =>
        JSON.stringify(attachment) === JSON.stringify(next.composerDraft.images[index]),
    ) &&
    current.composerDraft.mentionBindings.length ===
      next.composerDraft.mentionBindings.length &&
    current.composerDraft.mentionBindings.every(
      (binding, index) =>
        JSON.stringify(binding) ===
        JSON.stringify(next.composerDraft.mentionBindings[index]),
    )
  );
}

function isNewWorktreeNameOnlyChange(
  current: SavedDraftThreadState,
  next: SavedDraftThreadState,
) {
  if (
    !sameComposer(current.composer, next.composer) ||
    !sameDraft(current.composerDraft, next.composerDraft)
  ) {
    return false;
  }

  const currentSelection = current.projectSelection ?? null;
  const nextSelection = next.projectSelection ?? null;
  return (
    currentSelection?.kind === "new" &&
    nextSelection?.kind === "new" &&
    currentSelection.baseBranch === nextSelection.baseBranch &&
    currentSelection.name !== nextSelection.name
  );
}
