import { create } from "zustand";

import {
  LEGACY_WORKSPACE_LAYOUT_STORAGE_KEYS,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  readLocalStorageWithMigration,
} from "../lib/app-identity";
import * as bridge from "../lib/bridge";
import type {
  BootstrapStatus,
  EnvironmentRecord,
  GlobalSettings,
  ProjectSettingsPatch,
  ProjectRecord,
  ThreadRecord,
  WorkspaceSnapshot,
} from "../lib/types";
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

export type ThreadDraftState = {
  projectId: string;
};

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
  selectThread: (id: string | null) => void;

  // Thread draft composer orchestration.
  openThreadDraft: (projectId: string, slot?: SlotKey) => SlotKey | null;
  closeThreadDraft: (slot: SlotKey) => void;
};

let unlistenWorkspaceEvents: null | (() => void) = null;
let listenerInitialization: Promise<void> | null = null;
let listenerGeneration = 0;
let refreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let inflightRefresh: Promise<boolean> | null = null;
let queuedRefresh = false;

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  snapshot: null,
  bootstrapStatus: null,
  loadingState: "idle",
  error: null,
  listenerReady: false,

  layout: INITIAL_LAYOUT,

  draftBySlot: {},

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
        return {
          bootstrapStatus,
          snapshot,
          loadingState: "ready",
          ...withReconciledLayout(reconciled),
        };
      });
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
        return {
          snapshot,
          ...withReconciledLayout(reconciled),
        };
      });
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
        ...withReconciledLayout(reconciled),
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
      return withLayout({
        ...state.layout,
        slots: result.slots,
        focusedSlot: result.focusedSlot,
      });
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
      return withLayout({
        ...state.layout,
        slots: nextSlots,
        focusedSlot: plan.newSlot,
      });
    }),

  openThreadInSlot: (slot, threadId) =>
    set((state) => {
      if (!state.snapshot) return state;
      const resolved = resolveThreadSelection(state.snapshot, threadId);
      if (!resolved) return state;
      const slots = { ...state.layout.slots, [slot]: resolved };
      return {
        ...withLayout({
          ...state.layout,
          slots,
          focusedSlot: slot,
        }),
        draftBySlot: omitSlot(state.draftBySlot, slot),
      };
    }),

  // Writes a pane selection directly, bypassing snapshot lookup. Used when
  // the caller already owns an authoritative selection (e.g. a freshly
  // created thread returned by the bridge) and cannot wait for the next
  // workspace snapshot to propagate.
  setPaneSelection: (slot, selection) =>
    set((state) => {
      const slots = { ...state.layout.slots, [slot]: selection };
      return {
        ...withLayout({
          ...state.layout,
          slots,
          focusedSlot: slot,
        }),
        draftBySlot: omitSlot(state.draftBySlot, slot),
      };
    }),

  openThreadInOtherPane: (threadId) =>
    set((state) => {
      if (!state.snapshot) return state;
      const resolved = resolveThreadSelection(state.snapshot, threadId);
      if (!resolved) return state;
      if (countPanes(state.layout.slots) === 0) {
        const slots = { ...EMPTY_SLOTS, topLeft: resolved };
        return withLayout({
          ...state.layout,
          slots,
          focusedSlot: "topLeft",
        });
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
      return withLayout({
        ...state.layout,
        slots,
        focusedSlot: target,
      });
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
      return {
        ...withLayout({
          ...state.layout,
          slots: compacted,
          focusedSlot: nextFocus,
        }),
        draftBySlot: remappedDrafts,
      };
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
      return withLayout({ ...state.layout, focusedSlot: slot });
    }),

  selectProject: (id) =>
    set((state) => {
      const newSelection = buildProjectPane(state.snapshot, id);
      const target = state.layout.focusedSlot;
      if (!target) {
        if (!newSelection) return state;
        return {
          ...withLayout({
            ...state.layout,
            slots: { ...EMPTY_SLOTS, topLeft: newSelection },
            focusedSlot: "topLeft",
          }),
          draftBySlot: omitSlot(state.draftBySlot, "topLeft"),
        };
      }
      // When `newSelection` is null (id === null or unresolved project), we
      // clear the slot rather than inserting a placeholder selection — a
      // partial pane would still count as occupied and confuse the layout.
      const slots = {
        ...state.layout.slots,
        [target]: newSelection,
      };
      return {
        ...withLayout({ ...state.layout, slots }),
        draftBySlot: omitSlot(state.draftBySlot, target),
      };
    }),

  selectEnvironment: (id) =>
    set((state) => {
      const target = state.layout.focusedSlot;
      if (!target) {
        if (!id) return state;
        const newSelection = buildEnvironmentPane(state.snapshot, null, id);
        if (!newSelection) return state;
        return {
          ...withLayout({
            ...state.layout,
            slots: { ...EMPTY_SLOTS, topLeft: newSelection },
            focusedSlot: "topLeft",
          }),
          draftBySlot: omitSlot(state.draftBySlot, "topLeft"),
        };
      }
      const current = state.layout.slots[target] ?? null;
      const newSelection =
        buildEnvironmentPane(state.snapshot, current, id) ?? current;
      const slots = { ...state.layout.slots, [target]: newSelection };
      return {
        ...withLayout({ ...state.layout, slots }),
        draftBySlot: omitSlot(state.draftBySlot, target),
      };
    }),

  selectThread: (id) =>
    set((state) => {
      const target = state.layout.focusedSlot;
      if (!target) {
        if (!id || !state.snapshot) return state;
        const resolved = resolveThreadSelection(state.snapshot, id);
        if (!resolved) return state;
        return {
          ...withLayout({
            ...state.layout,
            slots: { ...EMPTY_SLOTS, topLeft: resolved },
            focusedSlot: "topLeft",
          }),
          draftBySlot: omitSlot(state.draftBySlot, "topLeft"),
        };
      }
      const current = state.layout.slots[target] ?? { projectId: null, environmentId: null, threadId: null };
      if (id === null) {
        const slots = {
          ...state.layout.slots,
          [target]: { ...current, threadId: null },
        };
        return {
          ...withLayout({ ...state.layout, slots }),
          draftBySlot: omitSlot(state.draftBySlot, target),
        };
      }
      if (!state.snapshot) {
        const slots = {
          ...state.layout.slots,
          [target]: { ...current, threadId: id },
        };
        return {
          ...withLayout({ ...state.layout, slots }),
          draftBySlot: omitSlot(state.draftBySlot, target),
        };
      }
      const resolved = resolveThreadSelection(state.snapshot, id);
      if (!resolved) {
        const slots = {
          ...state.layout.slots,
          [target]: { ...current, threadId: null },
        };
        return {
          ...withLayout({ ...state.layout, slots }),
          draftBySlot: omitSlot(state.draftBySlot, target),
        };
      }
      const slots = { ...state.layout.slots, [target]: resolved };
      return {
        ...withLayout({ ...state.layout, slots }),
        draftBySlot: omitSlot(state.draftBySlot, target),
      };
    }),

  openThreadDraft: (projectId, requestedSlot) => {
    let opened: SlotKey | null = null;
    set((state) => {
      const slot: SlotKey =
        requestedSlot ??
        state.layout.focusedSlot ??
        firstFilledSlot(state.layout.slots) ??
        "topLeft";
      opened = slot;
      const selection: PaneSelection = {
        projectId,
        environmentId: null,
        threadId: null,
      };
      const slots = { ...state.layout.slots, [slot]: selection };
      return {
        ...withLayout({ ...state.layout, slots, focusedSlot: slot }),
        draftBySlot: { ...state.draftBySlot, [slot]: { projectId } },
      };
    });
    return opened;
  },

  closeThreadDraft: (slot) =>
    set((state) => ({
      draftBySlot: omitSlot(state.draftBySlot, slot),
    })),
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
  if (!s.selectedEnvironmentId || !s.snapshot) return null;
  for (const project of s.snapshot.projects) {
    const env = project.environments.find(
      (e) => e.id === s.selectedEnvironmentId,
    );
    if (env) return env;
  }
  return null;
}

export function selectSelectedThread(s: WorkspaceState): ThreadRecord | null {
  if (!s.selectedThreadId || !s.snapshot) return null;
  for (const project of s.snapshot.projects) {
    for (const env of project.environments) {
      const thread = env.threads.find((t) => t.id === s.selectedThreadId);
      if (thread) return thread;
    }
  }
  return null;
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
    for (const project of s.snapshot.projects) {
      const env = project.environments.find(
        (e) => e.id === selection.environmentId,
      );
      if (env) return env;
    }
    return null;
  };
}

export function selectPaneThread(slot: SlotKey | null) {
  return (s: WorkspaceState) => {
    if (!slot || !s.snapshot) return null;
    const selection = s.layout.slots[slot];
    if (!selection?.threadId) return null;
    for (const project of s.snapshot.projects) {
      for (const env of project.environments) {
        const thread = env.threads.find((t) => t.id === selection.threadId);
        if (thread) return thread;
      }
    }
    return null;
  };
}

export function selectPaneDraft(slot: SlotKey | null) {
  return (s: WorkspaceState) => {
    if (!slot) return null;
    return s.draftBySlot[slot] ?? null;
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

/* ── Slot helpers ── */

function withLayout(layout: WorkspaceLayout) {
  // Ensure focusedSlot points to a filled slot when possible.
  const focused = layout.focusedSlot;
  const focusedValid = focused ? layout.slots[focused] !== null : false;
  const effectiveFocus: SlotKey | null = focusedValid
    ? focused
    : (firstFilledSlot(layout.slots) ?? null);
  const selection: PaneSelection | null = effectiveFocus
    ? layout.slots[effectiveFocus]
    : null;
  return {
    layout: { ...layout, focusedSlot: effectiveFocus },
    selectedProjectId: selection?.projectId ?? null,
    selectedEnvironmentId: selection?.environmentId ?? null,
    selectedThreadId: selection?.threadId ?? null,
  };
}

function withReconciledLayout(reconciled: ReconciledLayout) {
  return {
    ...withLayout(reconciled.layout),
    draftBySlot: reconciled.drafts,
  };
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
    projectId: found.project.id,
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
      nextSlots[key] = findProject(snapshot, draft.projectId)
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
    selectedEnvironment?.project.id ??
    selectedThread?.project.id ??
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
    projectId: resolved.project.id,
    environmentId: resolved.environment.id,
    threadId: thread?.id ?? null,
  };
}

function findProject(snapshot: WorkspaceSnapshot, projectId: string | null) {
  if (!projectId) return null;
  return snapshot.projects.find((project) => project.id === projectId) ?? null;
}

function findPrimaryEnvironment(project: ProjectRecord) {
  return (
    project.environments.find((environment) => environment.kind === "local") ??
    project.environments.find((environment) => environment.isDefault) ??
    project.environments[0] ??
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
      return { environment, project };
    }
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
        return { thread, environment, project };
      }
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

  return removed
    ? {
        ...snapshot,
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
      ...withReconciledLayout(reconciled),
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
    localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, payload);
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
    raw = readLocalStorageWithMigration(
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
