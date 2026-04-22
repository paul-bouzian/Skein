import { create } from "zustand";

import {
  LEGACY_WORKSPACE_LAYOUT_STORAGE_KEYS,
  WORKSPACE_LAYOUT_STORAGE_KEY,
} from "../lib/app-identity";
import * as bridge from "../lib/bridge";
import {
  persistUiPreference,
  readUiPreferenceWithMigration,
} from "../lib/ui-prefs";
import type {
  BootstrapStatus,
  ChatWorkspaceSnapshot,
  DraftThreadTarget,
  EnvironmentRecord,
  GlobalSettings,
  ProjectSettingsPatch,
  ProjectRecord,
  SavedDraftThreadState,
  ThreadRecord,
  WorkspaceSnapshot,
} from "../lib/types";
import {
  clearInvalidDraftThreadPersistenceControllers,
  clearDraftThreadPersistenceControllers,
  defaultDraftThreadState,
  draftThreadTargetKey,
  normalizeDraftThreadState,
  persistedDraftThreadState,
  persistenceModeForDraftThreadChange,
  scheduleDraftThreadPersistence,
  sameDraftThreadState,
} from "./draft-threads";
import { useTerminalStore } from "./terminal-store";

type LoadingState = "idle" | "loading" | "ready" | "error";

type WorkspaceMutationResult = {
  ok: boolean;
  refreshed: boolean;
  warningMessage: string | null;
  errorMessage: string | null;
};

type WorkspaceSettingsMutationResult = WorkspaceMutationResult & {
  settings: GlobalSettings | null;
};

type WorkspaceProjectMutationResult = WorkspaceMutationResult & {
  project: ProjectRecord | null;
};

type WorkspaceStateUpdate =
  | Partial<WorkspaceState>
  | WorkspaceState
  | ((state: WorkspaceState) => Partial<WorkspaceState> | WorkspaceState);

type WorkspaceSetter = (partial: WorkspaceStateUpdate) => void;
type ReconciledLayout = {
  layout: WorkspaceLayout;
  drafts: Partial<Record<SlotKey, ThreadDraftState>>;
};
const WORKSPACE_REFRESH_DEBOUNCE_MS = 200;

export type SlotKey = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";
export type PaneId = SlotKey;
export type PaneDirection = "top" | "right" | "bottom" | "left";

export type PaneSelection = {
  projectId: string | null;
  environmentId: string | null;
  threadId: string | null;
};

type ThreadSelectionStrategy = "focusedSlot" | "preferVisiblePane";

export type ThreadDraftState = DraftThreadTarget;
export type DraftThreadHydrationState = "cold" | "loading" | "ready" | "error";

export type WorkspaceLayout = {
  slots: Record<SlotKey, PaneSelection | null>;
  focusedSlot: SlotKey | null;
  rowRatio: number;
  colRatio: number;
};

export const SPLIT_RATIO_MIN = 0.35;
export const SPLIT_RATIO_MAX = 0.65;
export const MAX_PANES = 4;

const SLOT_KEYS: readonly SlotKey[] = [
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomRight",
] as const;

const EMPTY_SLOTS: Record<SlotKey, PaneSelection | null> = {
  topLeft: null,
  topRight: null,
  bottomLeft: null,
  bottomRight: null,
};

const INITIAL_LAYOUT: WorkspaceLayout = {
  slots: { ...EMPTY_SLOTS },
  focusedSlot: null,
  rowRatio: 0.5,
  colRatio: 0.5,
};

type WorkspaceState = {
  snapshot: WorkspaceSnapshot | null;
  bootstrapStatus: BootstrapStatus | null;
  loadingState: LoadingState;
  error: string | null;
  listenerReady: boolean;

  layout: WorkspaceLayout;

  // Ephemeral draft composer state per pane (not persisted).
  draftBySlot: Partial<Record<SlotKey, ThreadDraftState>>;
  draftStateByTargetKey: Record<string, SavedDraftThreadState>;
  draftHydrationByTargetKey: Record<string, DraftThreadHydrationState>;
  draftRevisionByTargetKey: Record<string, number>;

  // Compat fields derived from the focused slot.
  selectedProjectId: string | null;
  selectedEnvironmentId: string | null;
  selectedThreadId: string | null;

  initialize: () => Promise<void>;
  initializeListener: () => Promise<void>;
  refreshSnapshot: () => Promise<boolean>;
  updateGlobalSettings: (
    patch: Parameters<typeof bridge.updateGlobalSettings>[0],
  ) => Promise<WorkspaceSettingsMutationResult>;
  updateProjectSettings: (
    projectId: string,
    patch: ProjectSettingsPatch,
  ) => Promise<WorkspaceProjectMutationResult>;
  removeThread: (threadId: string) => boolean;
  reorderProjects: (projectIds: string[]) => Promise<WorkspaceMutationResult>;
  setProjectSidebarCollapsed: (
    projectId: string,
    collapsed: boolean,
  ) => Promise<WorkspaceMutationResult>;

  // Pane-layout operations
  dropThreadInDirection: (
    direction: PaneDirection,
    threadId: string,
  ) => void;
  applyDropPlan: (
    plan: {
      newSlot: SlotKey;
      updates: Array<{ slot: SlotKey; value: PaneSelection | null }>;
    },
    threadId: string,
  ) => void;
  openThreadInSlot: (slot: SlotKey, threadId: string) => void;
  setPaneSelection: (slot: SlotKey, selection: PaneSelection) => void;
  openThreadInOtherPane: (threadId: string) => void;
  closePane: (slot: SlotKey) => void;
  setRowRatio: (ratio: number) => void;
  setColRatio: (ratio: number) => void;
  focusPane: (slot: SlotKey) => void;

  // Compat setters — route to the focused slot.
  selectProject: (id: string | null) => void;
  selectEnvironment: (id: string | null) => void;
  selectThread: (
    id: string | null,
    options?: { strategy?: ThreadSelectionStrategy },
  ) => void;

  // Thread draft composer orchestration.
  openThreadDraft: (
    target: string | ThreadDraftState,
    slot?: SlotKey,
  ) => SlotKey | null;
  openChatDraft: (slot?: SlotKey) => SlotKey | null;
  updateThreadDraftTarget: (slot: SlotKey, target: ThreadDraftState) => void;
  closeThreadDraft: (slot: SlotKey) => void;
  hydrateDraftThreadState: (
    target: DraftThreadTarget,
  ) => Promise<SavedDraftThreadState | null>;
  updateDraftThreadState: (
    target: DraftThreadTarget,
    updater:
      | SavedDraftThreadState
      | ((state: SavedDraftThreadState) => SavedDraftThreadState),
  ) => void;
  clearDraftThreadState: (target: DraftThreadTarget) => void;
};

let unlistenWorkspaceEvents: null | (() => void) = null;
let listenerInitialization: Promise<void> | null = null;
let listenerGeneration = 0;
let refreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let inflightRefresh: Promise<boolean> | null = null;
let queuedRefresh = false;
const inflightDraftThreadLoads = new Map<
  string,
  Promise<SavedDraftThreadState | null>
>();

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  snapshot: null,
  bootstrapStatus: null,
  loadingState: "idle",
  error: null,
  listenerReady: false,

  layout: INITIAL_LAYOUT,

  draftBySlot: {},
  draftStateByTargetKey: {},
  draftHydrationByTargetKey: {},
  draftRevisionByTargetKey: {},

  selectedProjectId: null,
  selectedEnvironmentId: null,
  selectedThreadId: null,

  initialize: async () => {
    if (get().loadingState === "loading") return;
    set({ loadingState: "loading", error: null });
    try {
      const [bootstrapStatus, snapshot] = await Promise.all([
        bridge.getBootstrapStatus(),
        bridge.getWorkspaceSnapshot(),
      ]);
      useTerminalStore.getState().syncWorkspaceSnapshot(snapshot);
      const persistedLayout = readPersistedLayout();
      set((state) => {
        const base = persistedLayout ?? state.layout;
        const reconciled = reconcileLayout(snapshot, base, state.draftBySlot);
        const draftThreadCaches = reconcileDraftThreadCaches(snapshot, state);
        return {
          bootstrapStatus,
          snapshot,
          loadingState: "ready",
          ...withReconciledLayout(snapshot, reconciled),
          ...draftThreadCaches,
        };
      });
      clearInvalidDraftThreadPersistenceControllers(
        validDraftThreadTargetKeys(snapshot),
      );
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to load workspace";
      set({ loadingState: "error", error: message });
    }
  },

  initializeListener: async () => {
    if (get().listenerReady) return;
    if (listenerInitialization) {
      await listenerInitialization;
      return;
    }

    const generation = listenerGeneration;
    const initialization = bridge
      .listenToWorkspaceEvents(() => {
        scheduleWorkspaceRefresh(get);
      })
      .then((unlisten) => {
        if (generation !== listenerGeneration) {
          unlisten();
          return;
        }

        unlistenWorkspaceEvents = unlisten;
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

  refreshSnapshot: async () => {
    try {
      const snapshot = await bridge.getWorkspaceSnapshot();
      useTerminalStore.getState().syncWorkspaceSnapshot(snapshot);
      set((state) => {
        const reconciled = reconcileLayout(snapshot, state.layout, state.draftBySlot);
        const draftThreadCaches = reconcileDraftThreadCaches(snapshot, state);
        return {
          snapshot,
          ...withReconciledLayout(snapshot, reconciled),
          ...draftThreadCaches,
        };
      });
      clearInvalidDraftThreadPersistenceControllers(
        validDraftThreadTargetKeys(snapshot),
      );
      return true;
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to refresh workspace";
      set({ error: message });
      return false;
    }
  },

  updateGlobalSettings: async (patch) => {
    let settings: GlobalSettings | null = null;
    const result = await runWorkspaceMutation(set, get, {
      run: async () => {
        settings = await bridge.updateGlobalSettings(patch);
      },
      applySnapshot: (snapshot) =>
        settings
          ? {
              ...snapshot,
              settings,
            }
          : snapshot,
      writeFailureMessage: "Failed to save settings",
      refreshFailureMessage:
        "Settings were saved, but the workspace snapshot could not be refreshed.",
    });

    return {
      ...result,
      settings,
    };
  },

  updateProjectSettings: async (projectId, patch) => {
    let project: ProjectRecord | null = null;
    const result = await runWorkspaceMutation(set, get, {
      run: async () => {
        const nextProject = await bridge.updateProjectSettings({ projectId, patch });
        if (!nextProject) {
          throw new Error("Failed to save project settings");
        }
        project = nextProject;
      },
      applySnapshot: (snapshot) =>
        project ? mergeProjectSettingsIntoSnapshot(snapshot, project) : snapshot,
      writeFailureMessage: "Failed to save project settings",
      refreshFailureMessage:
        "Project settings were saved, but the workspace snapshot could not be refreshed.",
    });

    return {
      ...result,
      project,
    };
  },

  removeThread: (threadId) => {
    let removed = false;
    set((state) => {
      const nextSnapshot = removeThreadFromSnapshot(state.snapshot, threadId);
      if (!nextSnapshot || nextSnapshot === state.snapshot) {
        return state;
      }

      removed = true;
      const reconciled = reconcileLayout(nextSnapshot, state.layout, state.draftBySlot);
      return {
        snapshot: nextSnapshot,
        ...withReconciledLayout(nextSnapshot, reconciled),
      };
    });
    return removed;
  },

  reorderProjects: async (projectIds) => {
    return runWorkspaceMutation(set, get, {
      run: () => bridge.reorderProjects({ projectIds }),
      applySnapshot: (snapshot) =>
        reorderProjectsInSnapshot(snapshot, projectIds),
      writeFailureMessage: "Failed to reorder projects",
      refreshFailureMessage:
        "Project order saved, but the workspace failed to refresh.",
    });
  },

  setProjectSidebarCollapsed: async (projectId, collapsed) => {
    return runWorkspaceMutation(set, get, {
      run: () => bridge.setProjectSidebarCollapsed({ projectId, collapsed }),
      applySnapshot: (snapshot) =>
        setProjectSidebarCollapsedInSnapshot(snapshot, projectId, collapsed),
      writeFailureMessage: "Failed to update project collapse state",
      refreshFailureMessage:
        "Project collapse state saved, but the workspace failed to refresh.",
    });
  },

  dropThreadInDirection: (direction, threadId) =>
    set((state) => {
      if (!state.snapshot) return state;
      const resolved = resolveThreadSelection(state.snapshot, threadId);
      if (!resolved) return state;
      const result = applySlotDrop(state.layout.slots, direction, resolved);
      if (!result) return state;
      return withLayout(
        {
          ...state.layout,
          slots: result.slots,
          focusedSlot: result.focusedSlot,
        },
        state.snapshot,
        state.draftBySlot,
      );
    }),

  applyDropPlan: (plan, threadId) =>
    set((state) => {
      if (!state.snapshot) return state;
      const resolved = resolveThreadSelection(state.snapshot, threadId);
      if (!resolved) return state;
      const nextSlots = { ...state.layout.slots };
      for (const update of plan.updates) {
        nextSlots[update.slot] = update.value;
      }
      nextSlots[plan.newSlot] = resolved;
      return withLayout(
        {
          ...state.layout,
          slots: nextSlots,
          focusedSlot: plan.newSlot,
        },
        state.snapshot,
        state.draftBySlot,
      );
    }),

  openThreadInSlot: (slot, threadId) =>
    set((state) => {
      if (!state.snapshot) return state;
      const resolved = resolveThreadSelection(state.snapshot, threadId);
      if (!resolved) return state;
      const slots = { ...state.layout.slots, [slot]: resolved };
      const nextDrafts = omitSlot(state.draftBySlot, slot);
      return withLayoutAndDrafts(
        {
          ...state.layout,
          slots,
          focusedSlot: slot,
        },
        state.snapshot,
        nextDrafts,
      );
    }),

  // Writes a pane selection directly, bypassing snapshot lookup. Used when
  // the caller already owns an authoritative selection (e.g. a freshly
  // created thread returned by the bridge) and cannot wait for the next
  // workspace snapshot to propagate.
  setPaneSelection: (slot, selection) =>
    set((state) => {
      const slots = { ...state.layout.slots, [slot]: selection };
      const nextDrafts = omitSlot(state.draftBySlot, slot);
      return withLayoutAndDrafts(
        {
          ...state.layout,
          slots,
          focusedSlot: slot,
        },
        state.snapshot,
        nextDrafts,
      );
    }),

  openThreadInOtherPane: (threadId) =>
    set((state) => {
      if (!state.snapshot) return state;
      const resolved = resolveThreadSelection(state.snapshot, threadId);
      if (!resolved) return state;
      if (countPanes(state.layout.slots) === 0) {
        const slots = { ...EMPTY_SLOTS, topLeft: resolved };
        return withLayout(
          {
            ...state.layout,
            slots,
            focusedSlot: "topLeft",
          },
          state.snapshot,
          state.draftBySlot,
        );
      }
      // Pick an adjacent empty slot to the focused one, preferring right,
      // then below, then any remaining empty slot.
      const focusedSlot = state.layout.focusedSlot ?? firstFilledSlot(
        state.layout.slots,
      );
      if (!focusedSlot) return state;
      const target = pickNeighborSlot(state.layout.slots, focusedSlot);
      if (!target) return state;
      const slots = { ...state.layout.slots, [target]: resolved };
      return withLayout(
        {
          ...state.layout,
          slots,
          focusedSlot: target,
        },
        state.snapshot,
        state.draftBySlot,
      );
    }),

  closePane: (slot) =>
    set((state) => {
      if (!state.layout.slots[slot] && !state.draftBySlot[slot]) return state;
      // Capture the focused pane's selection so we can re-find its slot key
      // after compactSlots potentially shuffles entries.
      const focusedSelection =
        state.layout.focusedSlot && state.layout.focusedSlot !== slot
          ? state.layout.slots[state.layout.focusedSlot]
          : null;
      const slotsWithClosedCleared = {
        ...state.layout.slots,
        [slot]: null,
      };
      const draftsWithClosedCleared = omitSlot(state.draftBySlot, slot);
      const { slots: compacted, drafts: remappedDrafts } =
        compactSlotsAndDrafts(slotsWithClosedCleared, draftsWithClosedCleared);
      const relocated = focusedSelection
        ? (SLOT_KEYS.find((key) => compacted[key] === focusedSelection) ?? null)
        : null;
      const nextFocus = relocated ?? firstFilledSlot(compacted) ?? null;
      return withLayoutAndDrafts(
        {
          ...state.layout,
          slots: compacted,
          focusedSlot: nextFocus,
        },
        state.snapshot,
        remappedDrafts,
      );
    }),

  setRowRatio: (ratio) =>
    set((state) => ({
      layout: { ...state.layout, rowRatio: clampSplitRatio(ratio) },
    })),

  setColRatio: (ratio) =>
    set((state) => ({
      layout: { ...state.layout, colRatio: clampSplitRatio(ratio) },
    })),

  focusPane: (slot) =>
    set((state) => {
      if (state.layout.focusedSlot === slot) return state;
      if (!state.layout.slots[slot]) return state;
      return withLayout(
        { ...state.layout, focusedSlot: slot },
        state.snapshot,
        state.draftBySlot,
      );
    }),

  selectProject: (id) =>
    set((state) => {
      const newSelection = buildProjectPane(state.snapshot, id);
      const target = state.layout.focusedSlot;
      if (!target) {
        if (!newSelection) return state;
        return seedTopLeftSelection(state, newSelection);
      }
      // When `newSelection` is null (id === null or unresolved project), we
      // clear the slot rather than inserting a placeholder selection — a
      // partial pane would still count as occupied and confuse the layout.
      const slots = {
        ...state.layout.slots,
        [target]: newSelection,
      };
      const nextDrafts = omitSlot(state.draftBySlot, target);
      return withLayoutAndDrafts(
        { ...state.layout, slots },
        state.snapshot,
        nextDrafts,
      );
    }),

  selectEnvironment: (id) =>
    set((state) => {
      const target = state.layout.focusedSlot;
      if (!target) {
        if (!id) return state;
        const newSelection = buildEnvironmentPane(state.snapshot, null, id);
        if (!newSelection) return state;
        return seedTopLeftSelection(state, newSelection);
      }
      const current = state.layout.slots[target] ?? null;
      const newSelection =
        buildEnvironmentPane(state.snapshot, current, id) ?? current;
      const slots = { ...state.layout.slots, [target]: newSelection };
      const nextDrafts = omitSlot(state.draftBySlot, target);
      return withLayoutAndDrafts(
        { ...state.layout, slots },
        state.snapshot,
        nextDrafts,
      );
    }),

  selectThread: (id, options) =>
    set((state) => {
      return selectThreadWithStrategy(
        state,
        id,
        options?.strategy ?? "focusedSlot",
      );
    }),

  openThreadDraft: (targetInput, requestedSlot) => {
    let opened: SlotKey | null = null;
    let draftTarget: ThreadDraftState | null = null;
    set((state) => {
      draftTarget = normalizeDraftTarget(targetInput);
      const slot: SlotKey =
        requestedSlot ??
        state.layout.focusedSlot ??
        firstFilledSlot(state.layout.slots) ??
        "topLeft";
      opened = slot;
      const selection: PaneSelection = {
        projectId:
          draftTarget.kind === "project"
            ? draftTarget.projectId
            : (state.snapshot?.chat.projectId ?? null),
        environmentId: null,
        threadId: null,
      };
      const slots = { ...state.layout.slots, [slot]: selection };
      const nextDrafts = { ...state.draftBySlot, [slot]: draftTarget };
      return withLayoutAndDrafts(
        { ...state.layout, slots, focusedSlot: slot },
        state.snapshot,
        nextDrafts,
      );
    });
    if (draftTarget) {
      void get().hydrateDraftThreadState(draftTarget);
    }
    return opened;
  },

  openChatDraft: (slot) => get().openThreadDraft({ kind: "chat" }, slot),

  updateThreadDraftTarget: (slot, target) => {
    set((state) => {
      if (!state.draftBySlot[slot]) {
        return state;
      }
      const selection: PaneSelection = {
        projectId:
          target.kind === "project"
            ? target.projectId
            : (state.snapshot?.chat.projectId ?? null),
        environmentId: null,
        threadId: null,
      };
      const slots = { ...state.layout.slots, [slot]: selection };
      const nextDrafts = { ...state.draftBySlot, [slot]: target };
      return withLayoutAndDrafts(
        {
          ...state.layout,
          slots,
          focusedSlot: state.layout.focusedSlot ?? slot,
        },
        state.snapshot,
        nextDrafts,
      );
    });
    void get().hydrateDraftThreadState(target);
  },

  closeThreadDraft: (slot) =>
    set((state) => {
      const nextDrafts = omitSlot(state.draftBySlot, slot);
      return withLayoutAndDrafts(state.layout, state.snapshot, nextDrafts);
    }),

  hydrateDraftThreadState: async (target) => {
    const key = draftThreadTargetKey(target);
    const currentState = get();
    if (currentState.draftHydrationByTargetKey[key] === "ready") {
      return currentState.draftStateByTargetKey[key] ?? null;
    }

    const inflight = inflightDraftThreadLoads.get(key);
    if (inflight) {
      return inflight;
    }

    const loadPromise = (async () => {
      const snapshot = get().snapshot;
      if (!snapshot) {
        return null;
      }
      const revision = get().draftRevisionByTargetKey[key] ?? 0;
      set((state) => ({
        draftHydrationByTargetKey: {
          ...state.draftHydrationByTargetKey,
          [key]: "loading",
        },
      }));

      try {
        const persisted = await bridge.getDraftThreadState(target);
        const normalized =
          persisted == null ? null : normalizeDraftThreadState(target, persisted);
        set((state) => {
          if (!state.snapshot || !validDraftThreadTargetKeys(state.snapshot).has(key)) {
            return state;
          }
          const hydrationByTargetKey = {
            ...state.draftHydrationByTargetKey,
            [key]: "ready" as const,
          };
          if ((state.draftRevisionByTargetKey[key] ?? 0) !== revision) {
            return { draftHydrationByTargetKey: hydrationByTargetKey };
          }
          if (normalized == null) {
            return {
              draftHydrationByTargetKey: hydrationByTargetKey,
            };
          }
          return {
            draftStateByTargetKey: {
              ...state.draftStateByTargetKey,
              [key]: normalized,
            },
            draftHydrationByTargetKey: hydrationByTargetKey,
          };
        });
        return normalized;
      } catch {
        set((state) => ({
          draftHydrationByTargetKey: {
            ...state.draftHydrationByTargetKey,
            [key]: "error",
          },
        }));
        return null;
      }
    })();

    inflightDraftThreadLoads.set(key, loadPromise);
    try {
      return await loadPromise;
    } finally {
      if (inflightDraftThreadLoads.get(key) === loadPromise) {
        inflightDraftThreadLoads.delete(key);
      }
    }
  },

  updateDraftThreadState: (target, updater) => {
    let nextState: SavedDraftThreadState | null = null;
    let persistedState: SavedDraftThreadState | null = null;
    let persistenceMode: "debounced" | "immediate" = "immediate";

    set((state) => {
      const settings = state.snapshot?.settings ?? null;
      if (!settings) {
        return state;
      }
      const key = draftThreadTargetKey(target);
      const current =
        state.draftStateByTargetKey[key] ?? defaultDraftThreadState(target, settings);
      const updated =
        typeof updater === "function" ? updater(current) : updater;
      const normalized = normalizeDraftThreadState(target, updated);
      if (sameDraftThreadState(current, normalized)) {
        return state;
      }

      nextState = normalized;
      persistedState = persistedDraftThreadState(target, normalized, settings);
      persistenceMode = persistenceModeForDraftThreadChange(current, normalized);
      return {
        draftStateByTargetKey: {
          ...state.draftStateByTargetKey,
          [key]: normalized,
        },
        draftHydrationByTargetKey: {
          ...state.draftHydrationByTargetKey,
          [key]: "ready",
        },
        draftRevisionByTargetKey: {
          ...state.draftRevisionByTargetKey,
          [key]: (state.draftRevisionByTargetKey[key] ?? 0) + 1,
        },
      };
    });

    if (nextState) {
      scheduleDraftThreadPersistence(target, persistedState, persistenceMode);
    }
  },

  clearDraftThreadState: (target) => {
    const key = draftThreadTargetKey(target);
    set((state) => {
      const draftStateByTargetKey = { ...state.draftStateByTargetKey };
      delete draftStateByTargetKey[key];
      return {
        draftStateByTargetKey,
        draftHydrationByTargetKey: {
          ...state.draftHydrationByTargetKey,
          [key]: "ready",
        },
        draftRevisionByTargetKey: {
          ...state.draftRevisionByTargetKey,
          [key]: (state.draftRevisionByTargetKey[key] ?? 0) + 1,
        },
      };
    });
    scheduleDraftThreadPersistence(target, null, "immediate");
  },
}));

export function teardownWorkspaceListener() {
  listenerGeneration += 1;
  unlistenWorkspaceEvents?.();
  unlistenWorkspaceEvents = null;
  listenerInitialization = null;
  if (refreshTimer !== null) {
    globalThis.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  inflightRefresh = null;
  queuedRefresh = false;
  inflightDraftThreadLoads.clear();
  clearDraftThreadPersistenceControllers();
  useWorkspaceStore.setState({ listenerReady: false });
}

export function requestWorkspaceRefresh() {
  scheduleWorkspaceRefresh(useWorkspaceStore.getState);
}

function scheduleWorkspaceRefresh(get: () => WorkspaceState) {
  if (refreshTimer !== null) {
    globalThis.clearTimeout(refreshTimer);
  }

  refreshTimer = globalThis.setTimeout(() => {
    refreshTimer = null;
    void runWorkspaceRefresh(get).catch(() => undefined);
  }, WORKSPACE_REFRESH_DEBOUNCE_MS);
}

async function runWorkspaceRefresh(get: () => WorkspaceState): Promise<boolean> {
  if (inflightRefresh) {
    queuedRefresh = true;
    return inflightRefresh;
  }

  const request = get().refreshSnapshot();
  inflightRefresh = request;

  try {
    return await request;
  } finally {
    if (inflightRefresh === request) {
      inflightRefresh = null;
    }

    if (queuedRefresh) {
      queuedRefresh = false;
      scheduleWorkspaceRefresh(get);
    }
  }
}

/* ── Derived selectors ── */

export function selectProjects(s: WorkspaceState): ProjectRecord[] {
  return s.snapshot?.projects ?? [];
}

export function selectChatWorkspace(
  s: WorkspaceState,
): ChatWorkspaceSnapshot | null {
  return s.snapshot?.chat ?? null;
}

async function runWorkspaceMutation(
  set: WorkspaceSetter,
  get: () => WorkspaceState,
  options: {
    run: () => Promise<void>;
    applySnapshot: (snapshot: WorkspaceSnapshot) => WorkspaceSnapshot;
    writeFailureMessage: string;
    refreshFailureMessage: string;
  },
): Promise<WorkspaceMutationResult> {
  try {
    await options.run();
  } catch (cause: unknown) {
    const message =
      cause instanceof Error ? cause.message : options.writeFailureMessage;
    set({ error: message });
    return {
      ok: false,
      refreshed: false,
      warningMessage: null,
      errorMessage: message,
    };
  }

  applySnapshotMutation(set, options.applySnapshot);

  if (await get().refreshSnapshot()) {
    set({ error: null });
    return {
      ok: true,
      refreshed: true,
      warningMessage: null,
      errorMessage: null,
    };
  }

  set({ error: options.refreshFailureMessage });
  return {
    ok: true,
    refreshed: false,
    warningMessage: options.refreshFailureMessage,
    errorMessage: null,
  };
}

export function selectSettings(s: WorkspaceState): GlobalSettings | null {
  return s.snapshot?.settings ?? null;
}

export function selectSelectedProject(s: WorkspaceState): ProjectRecord | null {
  if (!s.selectedProjectId || !s.snapshot) return null;
  return (
    s.snapshot.projects.find((p) => p.id === s.selectedProjectId) ?? null
  );
}

export function selectSelectedEnvironment(
  s: WorkspaceState,
): EnvironmentRecord | null {
  return findEnvironment(s.snapshot, s.selectedEnvironmentId)?.environment ?? null;
}

export function selectEffectiveEnvironmentId(s: WorkspaceState): string | null {
  const { selection, draft } = resolveFocusedPaneContext(s.layout, s.draftBySlot);
  return (
    effectiveEnvironmentIdForLayout(s.snapshot, selection, draft) ??
    s.selectedEnvironmentId
  );
}

export function selectEffectiveEnvironment(
  s: WorkspaceState,
): EnvironmentRecord | null {
  return findEnvironment(s.snapshot, selectEffectiveEnvironmentId(s))?.environment ?? null;
}

export function selectEffectiveNonChatEnvironment(
  s: WorkspaceState,
): EnvironmentRecord | null {
  const environment = selectEffectiveEnvironment(s);
  return environment?.kind === "chat" ? null : environment;
}

export function selectEffectiveNonChatEnvironmentId(
  s: WorkspaceState,
): string | null {
  return selectEffectiveNonChatEnvironment(s)?.id ?? null;
}

export function selectSelectedThread(s: WorkspaceState): ThreadRecord | null {
  return findThreadInWorkspace(s.snapshot, s.selectedThreadId)?.thread ?? null;
}

export function selectLayout(s: WorkspaceState): WorkspaceLayout {
  return s.layout;
}

export function selectFocusedSlot(s: WorkspaceState): SlotKey | null {
  return s.layout.focusedSlot;
}

export function selectIsSplitOpen(s: WorkspaceState): boolean {
  return countPanes(s.layout.slots) > 1;
}

export function selectHasAnyPane(s: WorkspaceState): boolean {
  return countPanes(s.layout.slots) > 0;
}

export function selectThreadInAnyPane(threadId: string) {
  return (s: WorkspaceState) =>
    SLOT_KEYS.some((key) => s.layout.slots[key]?.threadId === threadId);
}

export function selectThreadInFocusedPane(threadId: string) {
  return (s: WorkspaceState) => {
    const focused = s.layout.focusedSlot;
    if (!focused) return false;
    return s.layout.slots[focused]?.threadId === threadId;
  };
}

export function selectPaneProject(slot: SlotKey | null) {
  return (s: WorkspaceState) => {
    if (!slot || !s.snapshot) return null;
    const selection = s.layout.slots[slot];
    if (!selection?.projectId) return null;
    return (
      s.snapshot.projects.find((p) => p.id === selection.projectId) ?? null
    );
  };
}

export function selectPaneEnvironment(slot: SlotKey | null) {
  return (s: WorkspaceState) => {
    if (!slot || !s.snapshot) return null;
    const selection = s.layout.slots[slot];
    if (!selection?.environmentId) return null;
    return findEnvironment(s.snapshot, selection.environmentId)?.environment ?? null;
  };
}

export function selectPaneThread(slot: SlotKey | null) {
  return (s: WorkspaceState) => {
    if (!slot || !s.snapshot) return null;
    const selection = s.layout.slots[slot];
    if (!selection?.threadId) return null;
    return findThreadInWorkspace(s.snapshot, selection.threadId)?.thread ?? null;
  };
}

export function selectPaneDraft(slot: SlotKey | null) {
  return (s: WorkspaceState) => {
    if (!slot) return null;
    return s.draftBySlot[slot] ?? null;
  };
}

export function selectDraftThreadState(target: DraftThreadTarget | null) {
  return (s: WorkspaceState) => {
    if (!target) {
      return null;
    }
    const key = draftThreadTargetKey(target);
    return s.draftStateByTargetKey[key] ?? null;
  };
}

function omitSlot(
  drafts: Partial<Record<SlotKey, ThreadDraftState>>,
  slot: SlotKey,
): Partial<Record<SlotKey, ThreadDraftState>> {
  if (!(slot in drafts)) return drafts;
  const next = { ...drafts };
  delete next[slot];
  return next;
}

function normalizeDraftTarget(
  target: string | ThreadDraftState,
): ThreadDraftState {
  return typeof target === "string" ? { kind: "project", projectId: target } : target;
}

function findSlotWithThread(
  slots: Record<SlotKey, PaneSelection | null>,
  threadId: string,
): SlotKey | null {
  return SLOT_KEYS.find((key) => slots[key]?.threadId === threadId) ?? null;
}

function selectThreadWithStrategy(
  state: WorkspaceState,
  id: string | null,
  strategy: ThreadSelectionStrategy,
): WorkspaceState | Partial<WorkspaceState> {
  if (id !== null && strategy === "preferVisiblePane") {
    const focusedSlot = state.layout.focusedSlot;
    if (
      focusedSlot &&
      state.layout.slots[focusedSlot]?.threadId === id
    ) {
      return state;
    }

    const visibleSlot = findSlotWithThread(state.layout.slots, id);
    if (visibleSlot) {
      return withLayout(
        { ...state.layout, focusedSlot: visibleSlot },
        state.snapshot,
        state.draftBySlot,
      );
    }
  }

  return selectThreadInFocusedSlot(state, id);
}

function selectThreadInFocusedSlot(
  state: WorkspaceState,
  id: string | null,
): WorkspaceState | Partial<WorkspaceState> {
  const target = state.layout.focusedSlot;
  if (!target) {
    if (!id || !state.snapshot) return state;
    const resolved = resolveThreadSelection(state.snapshot, id);
    if (!resolved) return state;
    return seedTopLeftSelection(state, resolved);
  }
  const current = state.layout.slots[target] ?? {
    projectId: null,
    environmentId: null,
    threadId: null,
  };
  if (id === null) {
    const slots = {
      ...state.layout.slots,
      [target]: { ...current, threadId: null },
    };
    const nextDrafts = omitSlot(state.draftBySlot, target);
    return withLayoutAndDrafts(
      { ...state.layout, slots },
      state.snapshot,
      nextDrafts,
    );
  }
  if (!state.snapshot) {
    const slots = {
      ...state.layout.slots,
      [target]: { ...current, threadId: id },
    };
    const nextDrafts = omitSlot(state.draftBySlot, target);
    return withLayoutAndDrafts(
      { ...state.layout, slots },
      state.snapshot,
      nextDrafts,
    );
  }
  const resolved = resolveThreadSelection(state.snapshot, id);
  if (!resolved) {
    const slots = {
      ...state.layout.slots,
      [target]: { ...current, threadId: null },
    };
    const nextDrafts = omitSlot(state.draftBySlot, target);
    return withLayoutAndDrafts(
      { ...state.layout, slots },
      state.snapshot,
      nextDrafts,
    );
  }
  const slots = { ...state.layout.slots, [target]: resolved };
  const nextDrafts = omitSlot(state.draftBySlot, target);
  return withLayoutAndDrafts(
    { ...state.layout, slots },
    state.snapshot,
    nextDrafts,
  );
}

/* ── Slot helpers ── */

function resolveFocusedSlot(layout: WorkspaceLayout): SlotKey | null {
  // Ensure focusedSlot points to a filled slot when possible.
  const focused = layout.focusedSlot;
  const focusedValid = focused ? layout.slots[focused] !== null : false;
  return focusedValid
    ? focused
    : (firstFilledSlot(layout.slots) ?? null);
}

function resolveFocusedPaneContext(
  layout: WorkspaceLayout,
  draftBySlot: Partial<Record<SlotKey, ThreadDraftState>>,
) {
  const focusedSlot = resolveFocusedSlot(layout);
  const selection = focusedSlot ? layout.slots[focusedSlot] : null;
  const draft = focusedSlot ? draftBySlot[focusedSlot] ?? null : null;
  return { focusedSlot, selection, draft };
}

function effectiveEnvironmentIdForLayout(
  snapshot: WorkspaceSnapshot | null,
  selection: PaneSelection | null,
  draft: ThreadDraftState | null,
) {
  if (selection?.environmentId) {
    return selection.environmentId;
  }
  if (!draft || !snapshot) {
    return null;
  }
  if (draft.kind === "chat") {
    return null;
  }
  const project = findProject(snapshot, draft.projectId);
  return project ? findLocalEnvironment(project)?.id ?? null : null;
}

function withLayout(
  layout: WorkspaceLayout,
  _snapshot: WorkspaceSnapshot | null,
  draftBySlot: Partial<Record<SlotKey, ThreadDraftState>>,
) {
  const { focusedSlot, selection } = resolveFocusedPaneContext(
    layout,
    draftBySlot,
  );
  return {
    layout: { ...layout, focusedSlot },
    selectedProjectId: selection?.projectId ?? null,
    selectedEnvironmentId: selection?.environmentId ?? null,
    selectedThreadId: selection?.threadId ?? null,
  };
}

function withReconciledLayout(
  snapshot: WorkspaceSnapshot | null,
  reconciled: ReconciledLayout,
) {
  return {
    ...withLayout(reconciled.layout, snapshot, reconciled.drafts),
    draftBySlot: reconciled.drafts,
  };
}

function withLayoutAndDrafts(
  layout: WorkspaceLayout,
  snapshot: WorkspaceSnapshot | null,
  draftBySlot: Partial<Record<SlotKey, ThreadDraftState>>,
) {
  return {
    ...withLayout(layout, snapshot, draftBySlot),
    draftBySlot,
  };
}

function seedTopLeftSelection(
  state: WorkspaceState,
  selection: PaneSelection,
) {
  const nextDrafts = omitSlot(state.draftBySlot, "topLeft");
  return withLayoutAndDrafts(
    {
      ...state.layout,
      slots: { ...EMPTY_SLOTS, topLeft: selection },
      focusedSlot: "topLeft",
    },
    state.snapshot,
    nextDrafts,
  );
}

function reconcileDraftThreadCaches(
  snapshot: WorkspaceSnapshot,
  state: WorkspaceState,
) {
  const validKeys = validDraftThreadTargetKeys(snapshot);

  return {
    draftStateByTargetKey: filterDraftThreadEntries(
      state.draftStateByTargetKey,
      validKeys,
    ),
    draftHydrationByTargetKey: filterDraftThreadEntries(
      state.draftHydrationByTargetKey,
      validKeys,
    ),
    draftRevisionByTargetKey: filterDraftThreadEntries(
      state.draftRevisionByTargetKey,
      validKeys,
    ),
  };
}

function validDraftThreadTargetKeys(snapshot: WorkspaceSnapshot) {
  return new Set<string>([
    "chat",
    ...snapshot.projects.map((project) => `project:${project.id}`),
  ]);
}

function filterDraftThreadEntries<Value>(
  entries: Record<string, Value>,
  validKeys: ReadonlySet<string>,
) {
  let changed = false;
  const nextEntries: Record<string, Value> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!validKeys.has(key)) {
      changed = true;
      continue;
    }
    nextEntries[key] = value;
  }

  return changed ? nextEntries : entries;
}

export function countPanes(
  slots: Record<SlotKey, PaneSelection | null>,
): number {
  return SLOT_KEYS.reduce(
    (sum, key) => sum + (slots[key] ? 1 : 0),
    0,
  );
}

function firstFilledSlot(
  slots: Record<SlotKey, PaneSelection | null>,
): SlotKey | null {
  return SLOT_KEYS.find((key) => slots[key] !== null) ?? null;
}

function clampSplitRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

/**
 * Compute the new slots when dropping `newSelection` on `direction`.
 *
 * The new pane occupies the "extreme" side (top→topLeft full width,
 * right→topRight full height, bottom→bottomLeft full width, left→topLeft full
 * height). Existing panes shift to the opposite side. If there's no room on
 * the opposite side (i.e. adding the new pane would exceed 4 panes), returns
 * null.
 *
 * Canonical positions are enforced: TL is always populated first, then TR or
 * BL depending on orientation, then BR.
 */
function applySlotDrop(
  current: Record<SlotKey, PaneSelection | null>,
  direction: PaneDirection,
  newSelection: PaneSelection,
): { slots: Record<SlotKey, PaneSelection | null>; focusedSlot: SlotKey } | null {
  const count = countPanes(current);
  if (count >= MAX_PANES) return null;

  // 0 panes: any drop places new in TL.
  if (count === 0) {
    return {
      slots: { ...EMPTY_SLOTS, topLeft: newSelection },
      focusedSlot: "topLeft",
    };
  }

  // 3 panes: drop may fill the 4th empty slot if the direction is compatible.
  if (count === 3) {
    const emptySlot = SLOT_KEYS.find((key) => current[key] === null);
    if (!emptySlot) return null;
    const allowed = allowedDirectionsForSlot(emptySlot);
    if (!allowed.has(direction)) return null;
    return {
      slots: { ...current, [emptySlot]: newSelection },
      focusedSlot: emptySlot,
    };
  }

  // 1 or 2 panes: new takes the target side, existing shift to opposite side.
  const existing = SLOT_KEYS
    .map((key) => current[key])
    .filter((value): value is PaneSelection => value !== null);

  const plan = buildShiftPlan(direction, existing.length);
  if (!plan) return null;

  const slots: Record<SlotKey, PaneSelection | null> = { ...EMPTY_SLOTS };
  slots[plan.newSlot] = newSelection;
  plan.existingSlots.forEach((slot, index) => {
    slots[slot] = existing[index] ?? null;
  });
  return { slots, focusedSlot: plan.newSlot };
}

function buildShiftPlan(
  direction: PaneDirection,
  existingCount: number,
): {
  newSlot: SlotKey;
  existingSlots: SlotKey[];
} | null {
  switch (direction) {
    case "top":
      return {
        newSlot: "topLeft",
        existingSlots: ["bottomLeft", "bottomRight"].slice(0, existingCount) as SlotKey[],
      };
    case "bottom":
      return {
        newSlot: "bottomLeft",
        existingSlots: ["topLeft", "topRight"].slice(0, existingCount) as SlotKey[],
      };
    case "left":
      return {
        newSlot: "topLeft",
        existingSlots: ["topRight", "bottomRight"].slice(0, existingCount) as SlotKey[],
      };
    case "right":
      return {
        newSlot: "topRight",
        existingSlots: ["topLeft", "bottomLeft"].slice(0, existingCount) as SlotKey[],
      };
  }
}

function allowedDirectionsForSlot(slot: SlotKey): Set<PaneDirection> {
  switch (slot) {
    case "topLeft":
      return new Set<PaneDirection>(["top", "left"]);
    case "topRight":
      return new Set<PaneDirection>(["top", "right"]);
    case "bottomLeft":
      return new Set<PaneDirection>(["bottom", "left"]);
    case "bottomRight":
      return new Set<PaneDirection>(["bottom", "right"]);
  }
}

function pickNeighborSlot(
  slots: Record<SlotKey, PaneSelection | null>,
  focused: SlotKey,
): SlotKey | null {
  // Prefer the horizontal neighbor, then vertical, then any remaining empty.
  const ordered: SlotKey[] = (() => {
    switch (focused) {
      case "topLeft":
        return ["topRight", "bottomLeft", "bottomRight"];
      case "topRight":
        return ["topLeft", "bottomRight", "bottomLeft"];
      case "bottomLeft":
        return ["bottomRight", "topLeft", "topRight"];
      case "bottomRight":
        return ["bottomLeft", "topRight", "topLeft"];
    }
  })();
  return ordered.find((slot) => slots[slot] === null) ?? null;
}

/**
 * Normalize the slot map so it represents a canonical grid. The invariant
 * we enforce is:
 *
 * - If any pane exists at all, `topLeft` is filled (the top row is never
 *   empty while bottom has panes).
 * - Within each row, filled cells shift to the left (no hole to the left of
 *   a filled pane inside the same row).
 *
 * We deliberately allow `topRight === null` while `bottomRight !== null`:
 * that arrangement represents a "1 pane at top (spans full width) + 2 panes
 * split at the bottom" layout — `topLeft`'s `colSpan` is 2 when `topRight`
 * is null, so the render covers the whole top row with no visual hole.
 * Pulling `bottomRight` up to `topRight` would force a different 3-pane
 * shape ("2 top split + 1 bottom span") and make panes jump vertically
 * when a corner is closed, which is not what the user asks for with close.
 */
// Compacts slots while remapping draft entries so
// each draft follows its pane selection's new position. Drafts whose source
// slot stays in place are preserved; drafts in now-empty slots are dropped.
function compactSlotsAndDrafts(
  slots: Record<SlotKey, PaneSelection | null>,
  drafts: Partial<Record<SlotKey, ThreadDraftState>>,
): {
  slots: Record<SlotKey, PaneSelection | null>;
  drafts: Partial<Record<SlotKey, ThreadDraftState>>;
} {
  let { topLeft: TL, topRight: TR, bottomLeft: BL, bottomRight: BR } = slots;
  let dTL = drafts.topLeft;
  let dTR = drafts.topRight;
  let dBL = drafts.bottomLeft;
  let dBR = drafts.bottomRight;

  // Promote the bottom row to the top when the top row is entirely empty.
  if (TL === null && TR === null && (BL !== null || BR !== null)) {
    TL = BL;
    TR = BR;
    BL = null;
    BR = null;
    dTL = dBL;
    dTR = dBR;
    dBL = undefined;
    dBR = undefined;
  }

  // Within each row, shift the filled cell to the left cell when empty.
  if (TL === null && TR !== null) {
    TL = TR;
    TR = null;
    dTL = dTR;
    dTR = undefined;
  }
  if (BL === null && BR !== null) {
    BL = BR;
    BR = null;
    dBL = dBR;
    dBR = undefined;
  }

  const nextDrafts: Partial<Record<SlotKey, ThreadDraftState>> = {};
  if (TL !== null && dTL !== undefined) nextDrafts.topLeft = dTL;
  if (TR !== null && dTR !== undefined) nextDrafts.topRight = dTR;
  if (BL !== null && dBL !== undefined) nextDrafts.bottomLeft = dBL;
  if (BR !== null && dBR !== undefined) nextDrafts.bottomRight = dBR;

  return {
    slots: { topLeft: TL, topRight: TR, bottomLeft: BL, bottomRight: BR },
    drafts: nextDrafts,
  };
}

function resolveThreadSelection(
  snapshot: WorkspaceSnapshot,
  threadId: string,
): PaneSelection | null {
  const found = findThreadInWorkspace(snapshot, threadId);
  if (!found) return null;
  return {
    projectId: found.projectId,
    environmentId: found.environment.id,
    threadId: found.thread.id,
  };
}

function reconcileLayout(
  snapshot: WorkspaceSnapshot,
  layout: WorkspaceLayout,
  draftBySlot: Partial<Record<SlotKey, ThreadDraftState>>,
): ReconciledLayout {
  const nextSlots: Record<SlotKey, PaneSelection | null> = {
    ...EMPTY_SLOTS,
  };
  for (const key of SLOT_KEYS) {
    const selection = layout.slots[key];
    if (!selection) {
      nextSlots[key] = null;
      continue;
    }
    // Draft panes hold `environmentId` / `threadId` intentionally null.
    // `reconcilePaneSelection` would fill them with the project's fallback
    // env + latest active thread, causing StudioPane to flip into
    // `ThreadConversation` and wipe the in-progress draft composer.
    if (draftBySlot[key]) {
      const draft = draftBySlot[key];
      nextSlots[key] =
        draft.kind === "chat"
          ? {
              projectId: snapshot.chat.projectId,
              environmentId: null,
              threadId: null,
            }
          : findProject(snapshot, draft.projectId)
            ? {
                projectId: draft.projectId,
                environmentId: null,
                threadId: null,
              }
            : null;
      continue;
    }
    nextSlots[key] = reconcilePaneSelection(snapshot, selection);
  }
  // Always canonicalize: a persisted or legacy layout may contain
  // non-canonical holes (e.g. TR filled without TL) that would leak into
  // slot-identity logic otherwise.
  const focusedSelection = layout.focusedSlot
    ? nextSlots[layout.focusedSlot]
    : null;
  const { slots: compacted, drafts: remappedDrafts } = compactSlotsAndDrafts(
    nextSlots,
    draftBySlot,
  );
  const relocatedFocus = focusedSelection
    ? (SLOT_KEYS.find((key) => compacted[key] === focusedSelection) ?? null)
    : null;
  const focusedSlot = relocatedFocus ?? firstFilledSlot(compacted);
  return {
    layout: {
      ...layout,
      slots: compacted,
      focusedSlot,
    },
    drafts: remappedDrafts,
  };
}

function reconcilePaneSelection(
  snapshot: WorkspaceSnapshot,
  pane: PaneSelection,
): PaneSelection | null {
  const selectedProject = findProject(snapshot, pane.projectId);
  const selectedEnvironment = findEnvironment(snapshot, pane.environmentId);
  const selectedThread = findThreadInWorkspace(snapshot, pane.threadId);

  // Close the pane when the user's explicit pick is entirely gone and
  // there is no legitimate neighbour to surface. Previously we redirected
  // to the project's local env, which left orphan "Local" panes locked
  // into the split view after a worktree deletion. The sibling-thread
  // fallback below still handles the archive-one-thread flow (env alive).
  if (
    pane.threadId !== null &&
    selectedThread === null &&
    pane.environmentId !== null &&
    selectedEnvironment === null
  ) {
    return null;
  }
  if (
    pane.environmentId !== null &&
    selectedEnvironment === null &&
    selectedThread === null
  ) {
    return null;
  }

  // Sibling-thread fallback: thread pick is gone but its env still
  // resolves → surface another active thread in that env so archiving a
  // single thread does not blank the pane.
  const siblingEnvironment =
    pane.threadId !== null && selectedThread === null && selectedEnvironment
      ? selectedEnvironment.environment
      : null;
  const siblingThread = siblingEnvironment
    ? findLatestActiveThread(siblingEnvironment)
    : null;

  // Primary-env fallback: project-only panes land on the project's
  // primary env + its latest active thread.
  const primaryEnvironment =
    pane.environmentId === null && pane.threadId === null && selectedProject
      ? findPrimaryEnvironment(selectedProject)
      : null;
  const primaryThread = primaryEnvironment
    ? findLatestActiveThread(primaryEnvironment)
    : null;

  const fallbackEnvironment = siblingEnvironment ?? primaryEnvironment;
  const fallbackThread = siblingThread ?? primaryThread;

  const projectId =
    selectedProject?.id ??
    selectedEnvironment?.projectId ??
    selectedThread?.projectId ??
    null;

  const environmentId =
    selectedEnvironment?.environment.id ??
    selectedThread?.environment.id ??
    fallbackEnvironment?.id ??
    null;

  const threadId = selectedThread?.thread.id ?? fallbackThread?.id ?? null;

  if (projectId === null && environmentId === null && threadId === null) {
    return null;
  }

  return { projectId, environmentId, threadId };
}

function buildProjectPane(
  snapshot: WorkspaceSnapshot | null,
  projectId: string | null,
): PaneSelection | null {
  if (!projectId) return null;
  if (!snapshot) {
    return { projectId, environmentId: null, threadId: null };
  }
  const project = findProject(snapshot, projectId);
  if (!project) return null;
  const environment = findPrimaryEnvironment(project);
  const thread = environment ? findLatestActiveThread(environment) : null;
  return {
    projectId: project.id,
    environmentId: environment?.id ?? null,
    threadId: thread?.id ?? null,
  };
}

function buildEnvironmentPane(
  snapshot: WorkspaceSnapshot | null,
  currentPane: PaneSelection | null,
  environmentId: string | null,
): PaneSelection | null {
  if (!environmentId) {
    if (!currentPane) return null;
    return { ...currentPane, environmentId: null, threadId: null };
  }
  if (!snapshot) {
    return {
      projectId: currentPane?.projectId ?? null,
      environmentId,
      threadId: null,
    };
  }
  const resolved = findEnvironment(snapshot, environmentId);
  if (!resolved) {
    return currentPane
      ? { ...currentPane, environmentId: null, threadId: null }
      : null;
  }
  const thread = findLatestActiveThread(resolved.environment);
  return {
    projectId: resolved.projectId,
    environmentId: resolved.environment.id,
    threadId: thread?.id ?? null,
  };
}

function findProject(snapshot: WorkspaceSnapshot, projectId: string | null) {
  if (!projectId) return null;
  return snapshot.projects.find((project) => project.id === projectId) ?? null;
}

export function findPrimaryEnvironment(project: ProjectRecord) {
  return (
    findLocalEnvironment(project) ??
    project.environments.find((environment) => environment.isDefault) ??
    project.environments[0] ??
    null
  );
}

function findLocalEnvironment(project: ProjectRecord) {
  return (
    project.environments.find((environment) => environment.kind === "local") ??
    null
  );
}

function findEnvironment(
  snapshot: WorkspaceSnapshot | null,
  environmentId: string | null,
) {
  if (!environmentId) return null;
  if (!snapshot) return null;
  for (const project of snapshot.projects) {
    const environment = project.environments.find(
      (candidate) => candidate.id === environmentId,
    );
    if (environment) {
      return { environment, project, projectId: project.id };
    }
  }
  const chatEnvironment = snapshot.chat.environments.find(
    (candidate) => candidate.id === environmentId,
  );
  if (chatEnvironment) {
    return {
      environment: chatEnvironment,
      project: null,
      projectId: snapshot.chat.projectId,
    };
  }
  return null;
}

function findLatestActiveThread(environment: EnvironmentRecord) {
  return (
    [...environment.threads]
      .filter((thread) => thread.status === "active")
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      )[0] ?? null
  );
}

export function findThreadInWorkspace(
  snapshot: WorkspaceSnapshot | null,
  threadId: string | null,
) {
  if (!snapshot || !threadId) return null;
  for (const project of snapshot.projects) {
    for (const environment of project.environments) {
      const thread = environment.threads.find(
        (candidate) => candidate.id === threadId,
      );
      if (thread) {
        return { thread, environment, project, projectId: project.id };
      }
    }
  }
  for (const environment of snapshot.chat.environments) {
    const thread = environment.threads.find((candidate) => candidate.id === threadId);
    if (thread) {
      return {
        thread,
        environment,
        project: null,
        projectId: snapshot.chat.projectId,
      };
    }
  }
  return null;
}

function removeThreadFromSnapshot(
  snapshot: WorkspaceSnapshot | null,
  threadId: string,
) {
  if (!snapshot) {
    return null;
  }

  let removed = false;
  const nextProjects = snapshot.projects.map((project) => {
    let projectChanged = false;
    const nextEnvironments = project.environments.map((environment) => {
      const nextThreads = environment.threads.filter(
        (thread) => thread.id !== threadId,
      );
      if (nextThreads.length === environment.threads.length) {
        return environment;
      }

      removed = true;
      projectChanged = true;
      return {
        ...environment,
        threads: nextThreads,
      };
    });

    if (!projectChanged) {
      return project;
    }

    return {
      ...project,
      environments: nextEnvironments,
    };
  });
  let chatChanged = false;
  const nextChatEnvironments = snapshot.chat.environments.map((environment) => {
    const nextThreads = environment.threads.filter((thread) => thread.id !== threadId);
    if (nextThreads.length === environment.threads.length) {
      return environment;
    }
    removed = true;
    chatChanged = true;
    return {
      ...environment,
      threads: nextThreads,
    };
  });
  const nextChat = chatChanged
    ? {
        ...snapshot.chat,
        environments: nextChatEnvironments,
      }
    : snapshot.chat;

  return removed
    ? {
        ...snapshot,
        chat: nextChat,
        projects: nextProjects,
      }
    : snapshot;
}

function applySnapshotMutation(
  set: WorkspaceSetter,
  applySnapshot: (snapshot: WorkspaceSnapshot) => WorkspaceSnapshot,
) {
  set((state) => {
    if (!state.snapshot) {
      return { error: null };
    }

    const nextSnapshot = applySnapshot(state.snapshot);
    if (nextSnapshot === state.snapshot) {
      return { error: null };
    }

    const reconciled = reconcileLayout(nextSnapshot, state.layout, state.draftBySlot);
    return {
      snapshot: nextSnapshot,
      error: null,
      ...withReconciledLayout(nextSnapshot, reconciled),
    };
  });
}

function reorderProjectsInSnapshot(
  snapshot: WorkspaceSnapshot,
  projectIds: string[],
) {
  const nextProjects = reorderRecordsById(snapshot.projects, projectIds);
  if (!nextProjects) {
    return snapshot;
  }

  return {
    ...snapshot,
    projects: nextProjects,
  };
}

function setProjectSidebarCollapsedInSnapshot(
  snapshot: WorkspaceSnapshot,
  projectId: string,
  collapsed: boolean,
) {
  let changed = false;
  const nextProjects = snapshot.projects.map((project) => {
    if (project.id !== projectId || project.sidebarCollapsed === collapsed) {
      return project;
    }

    changed = true;
    return {
      ...project,
      sidebarCollapsed: collapsed,
    };
  });

  return changed
    ? {
        ...snapshot,
        projects: nextProjects,
      }
    : snapshot;
}

function mergeProjectSettingsIntoSnapshot(
  snapshot: WorkspaceSnapshot,
  project: ProjectRecord,
) {
  let changed = false;
  const nextProjects = snapshot.projects.map((candidate) => {
    if (candidate.id !== project.id) {
      return candidate;
    }

    changed = true;
    return {
      ...candidate,
      settings: project.settings,
      updatedAt: project.updatedAt,
    };
  });

  return changed
    ? {
        ...snapshot,
        projects: nextProjects,
      }
    : snapshot;
}

function reorderRecordsById<RecordType extends { id: string }>(
  records: RecordType[],
  ids: string[],
) {
  if (records.length !== ids.length) {
    return null;
  }

  const recordsById = new Map(records.map((record) => [record.id, record]));
  const orderedRecords = ids
    .map((id) => recordsById.get(id))
    .filter((record): record is RecordType => record != null);

  if (orderedRecords.length !== records.length) {
    return null;
  }

  return orderedRecords;
}

/* ── Layout persistence ── */

const PERSIST_LAYOUT_DEBOUNCE_MS = 100;
let persistLayoutTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

function persistLayoutNow(layout: WorkspaceLayout) {
  try {
    const payload = JSON.stringify({
      slots: layout.slots,
      focusedSlot: layout.focusedSlot,
      rowRatio: layout.rowRatio,
      colRatio: layout.colRatio,
    });
    void persistUiPreference(WORKSPACE_LAYOUT_STORAGE_KEY, payload);
  } catch {
    /* storage quota or disabled — ignore */
  }
}

function schedulePersistLayout(layout: WorkspaceLayout) {
  if (persistLayoutTimer !== null) {
    globalThis.clearTimeout(persistLayoutTimer);
  }
  persistLayoutTimer = globalThis.setTimeout(() => {
    persistLayoutTimer = null;
    persistLayoutNow(layout);
  }, PERSIST_LAYOUT_DEBOUNCE_MS);
}

function readPersistedLayout(): WorkspaceLayout | null {
  let raw: string | null;
  try {
    raw = readUiPreferenceWithMigration(
      WORKSPACE_LAYOUT_STORAGE_KEY,
      LEGACY_WORKSPACE_LAYOUT_STORAGE_KEYS,
    );
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as {
    slots?: unknown;
    focusedSlot?: unknown;
    rowRatio?: unknown;
    colRatio?: unknown;
  };
  const slots = coerceSlots(candidate.slots);
  if (!slots) return null;
  const focusedSlot =
    typeof candidate.focusedSlot === "string" &&
    SLOT_KEYS.includes(candidate.focusedSlot as SlotKey) &&
    slots[candidate.focusedSlot as SlotKey] !== null
      ? (candidate.focusedSlot as SlotKey)
      : firstFilledSlot(slots);
  const rowRatio =
    typeof candidate.rowRatio === "number"
      ? clampSplitRatio(candidate.rowRatio)
      : 0.5;
  const colRatio =
    typeof candidate.colRatio === "number"
      ? clampSplitRatio(candidate.colRatio)
      : 0.5;
  return { slots, focusedSlot, rowRatio, colRatio };
}

function coerceSlots(
  value: unknown,
): Record<SlotKey, PaneSelection | null> | null {
  if (!value || typeof value !== "object") return null;
  const next: Record<SlotKey, PaneSelection | null> = { ...EMPTY_SLOTS };
  for (const key of SLOT_KEYS) {
    next[key] = coercePaneSelection((value as Record<string, unknown>)[key]);
  }
  return next;
}

function coercePaneSelection(value: unknown): PaneSelection | null {
  if (!value || typeof value !== "object") return null;
  const pane = value as Partial<Record<keyof PaneSelection, unknown>>;
  const result: PaneSelection = {
    projectId: typeof pane.projectId === "string" ? pane.projectId : null,
    environmentId:
      typeof pane.environmentId === "string" ? pane.environmentId : null,
    threadId: typeof pane.threadId === "string" ? pane.threadId : null,
  };
  if (!result.projectId && !result.environmentId && !result.threadId) {
    return null;
  }
  return result;
}

// Seed with the current layout so the subscribe doesn't treat the very first
// unrelated state update (e.g. `loadingState`) as a layout change and schedule
// a write of INITIAL_LAYOUT before `initialize()` has had a chance to read the
// persisted copy.
let persistedLayoutPrev: WorkspaceLayout = useWorkspaceStore.getState().layout;
useWorkspaceStore.subscribe((state) => {
  if (state.layout !== persistedLayoutPrev) {
    persistedLayoutPrev = state.layout;
    schedulePersistLayout(state.layout);
  }
});
