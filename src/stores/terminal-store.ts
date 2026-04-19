import { create } from "zustand";

import {
  LEGACY_TERMINAL_HEIGHT_STORAGE_KEYS,
  LEGACY_TERMINAL_LAYOUTS_STORAGE_KEYS,
  TERMINAL_HEIGHT_STORAGE_KEY,
  TERMINAL_LAYOUTS_STORAGE_KEY,
  readLocalStorageWithMigration,
} from "../lib/app-identity";
import * as bridge from "../lib/bridge";
import type {
  ProjectActionIcon,
  ProjectActionRunState,
  ProjectActionStateEventPayload,
  ProjectManualAction,
  WorkspaceSnapshot,
} from "../lib/types";
import {
  dropPendingTerminalOutput,
  ensureTerminalOutputBusReady,
} from "../lib/terminal-output-bus";

const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 120;
export const MAX_TABS = 10;
const pendingActionTabOpens = new Map<string, Promise<string | null>>();
const pendingProjectActionStates = new Map<string, ProjectActionStateEventPayload>();
let terminalEventSubscriptionsPromise: Promise<void> | null = null;
let terminalEventUnlisteners: Array<() => void> = [];

type PersistedTerminalLayout = {
  visible: boolean;
  height: number;
};

type PersistedTerminalLayouts = Record<string, PersistedTerminalLayout>;

let persistedLayoutsCache: PersistedTerminalLayouts | null = null;
let persistedLayoutsRawCache: string | null = null;
let hasLoadedPersistedLayouts = false;

function clampHeight(value: number): number {
  const max = Math.floor(window.innerHeight * 0.8);
  return Math.max(MIN_HEIGHT, Math.min(value, max));
}

function readLegacyHeight(): number {
  try {
    const rawValue = readLocalStorageWithMigration(
      TERMINAL_HEIGHT_STORAGE_KEY,
      LEGACY_TERMINAL_HEIGHT_STORAGE_KEYS,
    );
    if (rawValue == null) return DEFAULT_HEIGHT;
    const value = Number(rawValue);
    if (Number.isFinite(value)) return clampHeight(value);
  } catch {
    /* ignore */
  }
  return DEFAULT_HEIGHT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function basenameOf(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? "shell";
}

function actionTabOperationKey(environmentId: string, actionId: string) {
  return `${environmentId}\u0000${actionId}`;
}

function actionRunStateFor(tab: TerminalTab): ProjectActionRunState | null {
  if (tab.kind !== "manualAction") {
    return null;
  }
  return tab.actionRunState ?? (tab.exited ? "exited" : "running");
}

function normalizeTerminalTab(tab: TerminalTab): TerminalTab {
  if (tab.kind !== "manualAction") {
    return tab;
  }
  return {
    ...tab,
    actionRunState: actionRunStateFor(tab) ?? "running",
  };
}

export type TerminalTab = {
  id: string;
  ptyId: string;
  title: string;
  cwd: string;
  exited: boolean;
  kind: "shell" | "manualAction";
  actionId?: string;
  actionLabel?: string;
  actionIcon?: ProjectActionIcon;
  actionRunState?: ProjectActionRunState;
};

export type EnvironmentTerminalSlot = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  visible: boolean;
  height: number;
};

const legacyHeight = readLegacyHeight();

function defaultTerminalSlot(
  layout?: Partial<PersistedTerminalLayout>,
): EnvironmentTerminalSlot {
  return {
    tabs: [],
    activeTabId: null,
    visible: layout?.visible === true,
    height: clampHeight(layout?.height ?? legacyHeight),
  };
}

export const EMPTY_TERMINAL_SLOT: EnvironmentTerminalSlot = Object.freeze(
  defaultTerminalSlot(),
);

function parsePersistedLayouts(rawValue: string | null): PersistedTerminalLayouts {
  if (rawValue == null) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!isRecord(parsed)) {
      return {};
    }

    const layouts: PersistedTerminalLayouts = {};
    for (const [environmentId, rawLayout] of Object.entries(parsed)) {
      if (!isRecord(rawLayout)) {
        continue;
      }

      const heightValue =
        typeof rawLayout.height === "number"
          ? rawLayout.height
          : Number(rawLayout.height);
      layouts[environmentId] = {
        visible: rawLayout.visible === true,
        height: Number.isFinite(heightValue)
          ? clampHeight(heightValue)
          : legacyHeight,
      };
    }
    return layouts;
  } catch {
    return {};
  }
}

function readPersistedLayouts(): PersistedTerminalLayouts {
  let rawValue: string | null = null;

  try {
    rawValue = hasLoadedPersistedLayouts
      ? localStorage.getItem(TERMINAL_LAYOUTS_STORAGE_KEY)
      : readLocalStorageWithMigration(
          TERMINAL_LAYOUTS_STORAGE_KEY,
          LEGACY_TERMINAL_LAYOUTS_STORAGE_KEYS,
        );
  } catch {
    rawValue = null;
  }

  if (
    hasLoadedPersistedLayouts &&
    persistedLayoutsCache != null &&
    rawValue === persistedLayoutsRawCache
  ) {
    return persistedLayoutsCache;
  }

  const layouts = parsePersistedLayouts(rawValue);
  persistedLayoutsCache = layouts;
  persistedLayoutsRawCache = rawValue;
  hasLoadedPersistedLayouts = true;
  return layouts;
}

function writePersistedLayouts(layouts: PersistedTerminalLayouts) {
  try {
    const rawValue = JSON.stringify(layouts);
    localStorage.setItem(TERMINAL_LAYOUTS_STORAGE_KEY, rawValue);
    persistedLayoutsCache = layouts;
    persistedLayoutsRawCache = rawValue;
    hasLoadedPersistedLayouts = true;
  } catch {
    /* ignore */
  }
}

function persistedLayoutFor(environmentId: string) {
  return readPersistedLayouts()[environmentId];
}

function persistSlot(environmentId: string, slot: EnvironmentTerminalSlot) {
  const persistedLayouts = readPersistedLayouts();
  writePersistedLayouts({
    ...persistedLayouts,
    [environmentId]: {
      visible: slot.visible,
      height: slot.height,
    },
  });
}

function dropPersistedLayouts(environmentIds: string[]) {
  if (environmentIds.length === 0) {
    return;
  }

  const nextLayouts = { ...readPersistedLayouts() };
  let changed = false;
  for (const environmentId of environmentIds) {
    if (!(environmentId in nextLayouts)) {
      continue;
    }
    delete nextLayouts[environmentId];
    changed = true;
  }

  if (changed) {
    writePersistedLayouts(nextLayouts);
  }
}

function normalizeSlot(
  slot: EnvironmentTerminalSlot | undefined,
  environmentId: string,
): EnvironmentTerminalSlot {
  if (!slot) {
    return defaultTerminalSlot(persistedLayoutFor(environmentId));
  }

  let persistedLayout: PersistedTerminalLayout | undefined;
  const resolveDefaults = () => {
    persistedLayout ??= persistedLayoutFor(environmentId);
    return defaultTerminalSlot(persistedLayout);
  };

  return {
    tabs: Array.isArray(slot.tabs) ? slot.tabs.map(normalizeTerminalTab) : [],
    activeTabId: slot.activeTabId ?? null,
    visible:
      typeof slot.visible === "boolean"
        ? slot.visible
        : resolveDefaults().visible,
    height:
      typeof slot.height === "number" && Number.isFinite(slot.height)
        ? clampHeight(slot.height)
        : resolveDefaults().height,
  };
}

function slotForEnvironment(
  byEnv: Record<string, EnvironmentTerminalSlot>,
  environmentId: string,
): EnvironmentTerminalSlot {
  return normalizeSlot(byEnv[environmentId], environmentId);
}

function isKnownEnvironment(
  knownEnvironmentIds: string[],
  environmentId: string,
) {
  return knownEnvironmentIds.includes(environmentId);
}

async function killTerminalSession(ptyId: string) {
  try {
    await bridge.killTerminal({ ptyId });
  } catch {
    /* ignore: terminal may already be dead */
  } finally {
    pendingProjectActionStates.delete(ptyId);
    dropPendingTerminalOutput(ptyId);
  }
}

function mapTabsByPtyId(
  byEnv: Record<string, EnvironmentTerminalSlot>,
  ptyId: string,
  updateTab: (tab: TerminalTab) => TerminalTab,
) {
  let changed = false;
  const nextByEnv = Object.fromEntries(
    Object.entries(byEnv).map(([environmentId, rawSlot]) => {
      const slot = normalizeSlot(rawSlot, environmentId);
      let slotChanged = false;
      const tabs = slot.tabs.map((tab) => {
        if (tab.ptyId !== ptyId) {
          return tab;
        }
        const nextTab = updateTab(tab);
        if (nextTab !== tab) {
          slotChanged = true;
        }
        return nextTab;
      });
      changed ||= slotChanged;
      return [environmentId, slotChanged ? { ...slot, tabs } : slot];
    }),
  );

  return changed ? nextByEnv : byEnv;
}

function applyProjectActionStateEvent(
  byEnv: Record<string, EnvironmentTerminalSlot>,
  payload: ProjectActionStateEventPayload,
) {
  const nextByEnv = mapTabsByPtyId(byEnv, payload.ptyId, (tab) =>
    tab.kind !== "manualAction"
      ? tab
      : {
          ...tab,
          exited: payload.state === "exited",
          actionRunState: payload.state,
        },
  );
  if (nextByEnv === byEnv) {
    pendingProjectActionStates.set(payload.ptyId, payload);
  } else {
    pendingProjectActionStates.delete(payload.ptyId);
  }

  return nextByEnv;
}

function consumePendingProjectActionState(
  ptyId: string,
  actionId: string,
): ProjectActionStateEventPayload | null {
  const payload = pendingProjectActionStates.get(ptyId);
  if (!payload || payload.actionId !== actionId) {
    return null;
  }
  pendingProjectActionStates.delete(ptyId);
  return payload;
}

function clearTerminalEventSubscriptions() {
  const unlisteners = terminalEventUnlisteners;
  terminalEventUnlisteners = [];
  for (const unlisten of unlisteners) {
    unlisten();
  }
}

function ensureTerminalEventSubscriptionsReady(): Promise<void> {
  if (terminalEventSubscriptionsPromise) {
    return terminalEventSubscriptionsPromise;
  }

  const exitPromise = bridge.listenToTerminalExit((payload) => {
    useTerminalStore.getState().markExited(payload.ptyId);
  });
  const statePromise = bridge.listenToProjectActionState((payload) => {
    useTerminalStore.getState().syncProjectActionState(payload);
  });

  terminalEventSubscriptionsPromise = Promise.allSettled([
    exitPromise,
    statePromise,
  ]).then((results) => {
    terminalEventUnlisteners = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );

    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) {
      clearTerminalEventSubscriptions();
      terminalEventSubscriptionsPromise = null;
      throw rejected.reason;
    }
  });

  return terminalEventSubscriptionsPromise;
}

export function __resetTerminalEventSubscriptions(): void {
  clearTerminalEventSubscriptions();
  pendingProjectActionStates.clear();
  terminalEventSubscriptionsPromise = null;
}

type TerminalState = {
  // Tabs and panel chrome are keyed by environmentId so the selected worktree
  // restores its own terminal state without leaking visibility or size to
  // sibling environments.
  byEnv: Record<string, EnvironmentTerminalSlot>;
  knownEnvironmentIds: string[];

  toggleVisible: (environmentId: string) => void;
  setVisible: (environmentId: string, visible: boolean) => void;
  setHeight: (environmentId: string, value: number) => void;
  reconcileEnvironments: (environmentIds: string[]) => void;
  syncWorkspaceSnapshot: (snapshot: WorkspaceSnapshot) => void;

  openTab: (environmentId: string) => Promise<string | null>;
  openActionTab: (
    environmentId: string,
    action: Pick<ProjectManualAction, "id" | "label" | "icon">,
  ) => Promise<string | null>;
  closeTab: (environmentId: string, id: string) => Promise<void>;
  activateTab: (environmentId: string, id: string) => void;
  markExited: (ptyId: string) => void;
  syncProjectActionState: (payload: ProjectActionStateEventPayload) => void;
};

export const useTerminalStore = create<TerminalState>((set, get) => {
  function updateSlot(
    environmentId: string,
    updater: (slot: EnvironmentTerminalSlot) => EnvironmentTerminalSlot,
  ) {
    let nextSlot: EnvironmentTerminalSlot | null = null;
    let shouldPersist = false;
    set((state) => {
      const currentSlot = slotForEnvironment(state.byEnv, environmentId);
      nextSlot = updater(currentSlot);
      shouldPersist =
        currentSlot.visible !== nextSlot.visible ||
        currentSlot.height !== nextSlot.height;
      return {
        byEnv: {
          ...state.byEnv,
          [environmentId]: nextSlot as EnvironmentTerminalSlot,
        },
      };
    });
    if (nextSlot && shouldPersist) {
      persistSlot(environmentId, nextSlot);
    }
    return nextSlot;
  }

  return {
    byEnv: {},
    knownEnvironmentIds: [],

    toggleVisible: (environmentId) => {
      updateSlot(environmentId, (slot) => ({
        ...slot,
        visible: !slot.visible,
      }));
    },

    setVisible: (environmentId, visible) => {
      updateSlot(environmentId, (slot) => ({
        ...slot,
        visible,
      }));
    },

    setHeight: (environmentId, value) => {
      updateSlot(environmentId, (slot) => ({
        ...slot,
        height: clampHeight(value),
      }));
    },

    reconcileEnvironments: (environmentIds) => {
      const ptyIdsToKill: string[] = [];
      const removedEnvironmentIds: string[] = [];
      set((state) =>
        reconcileTerminalSnapshot(
          state,
          environmentIds,
          ptyIdsToKill,
          removedEnvironmentIds,
        ),
      );
      dropPersistedLayouts(removedEnvironmentIds);
      disposeTerminals(ptyIdsToKill);
    },

    syncWorkspaceSnapshot: (snapshot) => {
      const metadataByEnv = collectEnvironmentMetadata(snapshot);
      const environmentIds = [...metadataByEnv.keys()];
      const ptyIdsToKill: string[] = [];
      const removedEnvironmentIds: string[] = [];

      set((state) =>
        reconcileTerminalSnapshot(
          state,
          environmentIds,
          ptyIdsToKill,
          removedEnvironmentIds,
          (slot, environmentId) => {
            const metadata = metadataByEnv.get(environmentId);
            if (!metadata) {
              return slot;
            }

            return {
              ...slot,
              tabs: slot.tabs.map((tab) => ({
                ...tab,
                cwd: metadata.path,
                title: tab.kind === "shell" ? basenameOf(metadata.path) : tab.title,
              })),
            };
          },
        ),
      );

      dropPersistedLayouts(removedEnvironmentIds);
      disposeTerminals(ptyIdsToKill);
    },

    openTab: async (environmentId) => {
      const slot = slotForEnvironment(get().byEnv, environmentId);
      if (slot.tabs.length >= MAX_TABS) return null;
      // Attach the output bus BEFORE spawning so any bytes emitted between
      // spawn and the TerminalView subscribe are buffered, not dropped.
      await Promise.all([
        ensureTerminalOutputBusReady(),
        ensureTerminalEventSubscriptionsReady(),
      ]);
      // Generous defaults; FitAddon will resize immediately after mount.
      const { ptyId, cwd } = await bridge.spawnTerminal({
        environmentId,
        cols: 80,
        rows: 24,
      });
      // Re-check the cap after the async spawn: concurrent openTab calls can
      // both pass the initial check. If we raced past the cap, kill the PTY we
      // just created and bail.
      const slotAfter = slotForEnvironment(get().byEnv, environmentId);
      if (
        !isKnownEnvironment(get().knownEnvironmentIds, environmentId) ||
        slotAfter.tabs.length >= MAX_TABS
      ) {
        await killTerminalSession(ptyId);
        return null;
      }

      const id = crypto.randomUUID();
      updateSlot(environmentId, (existing) => ({
        ...existing,
        visible: true,
        tabs: [
          ...existing.tabs,
          {
            id,
            ptyId,
            cwd,
            title: basenameOf(cwd),
            exited: false,
            kind: "shell",
          },
        ],
        activeTabId: id,
      }));
      return id;
    },

    openActionTab: async (environmentId, action) => {
      const slot = slotForEnvironment(get().byEnv, environmentId);
      const actionTab = slot.tabs.find(
        (tab) => tab.kind === "manualAction" && tab.actionId === action.id,
      );
      if (actionTab && actionRunStateFor(actionTab) === "running") {
        updateSlot(environmentId, (existing) => ({
          ...existing,
          visible: true,
          activeTabId: actionTab.id,
        }));
        return actionTab.id;
      }

      const operationKey = actionTabOperationKey(environmentId, action.id);
      const pendingOpen = pendingActionTabOpens.get(operationKey);
      if (pendingOpen) {
        return pendingOpen;
      }

      const replacementTab = actionTab ?? null;
      const nextTabCount = replacementTab ? slot.tabs.length : slot.tabs.length + 1;
      if (nextTabCount > MAX_TABS) {
        return null;
      }

      if (replacementTab) {
        updateSlot(environmentId, (existing) => ({
          ...existing,
          visible: true,
          activeTabId: replacementTab.id,
        }));
      }

      const openPromise = (async () => {
        await Promise.all([
          ensureTerminalOutputBusReady(),
          ensureTerminalEventSubscriptionsReady(),
        ]);
        const { ptyId, cwd, actionId, actionLabel, actionIcon } =
          await bridge.runProjectAction({
            environmentId,
            actionId: action.id,
          });
        const slotAfter = slotForEnvironment(get().byEnv, environmentId);
        const replacementTabStillPresent =
          replacementTab != null &&
          slotAfter.tabs.some((tab) => tab.id === replacementTab.id);
        const currentReplacementTab =
          replacementTabStillPresent && replacementTab
            ? (slotAfter.tabs.find((tab) => tab.id === replacementTab.id) ??
              replacementTab)
            : null;
        const nextTabCount = currentReplacementTab
          ? slotAfter.tabs.length
          : slotAfter.tabs.length + 1;
        if (
          !isKnownEnvironment(get().knownEnvironmentIds, environmentId) ||
          nextTabCount > MAX_TABS
        ) {
          await killTerminalSession(ptyId);
          return null;
        }

        const nextTabId =
          currentReplacementTab?.id ?? crypto.randomUUID();
        const pendingState = consumePendingProjectActionState(ptyId, actionId);
        const actionRunState = pendingState?.state ?? "running";
        const nextTab: TerminalTab = {
          id: nextTabId,
          ptyId,
          cwd,
          title: actionLabel,
          exited: actionRunState === "exited",
          kind: "manualAction",
          actionId,
          actionLabel,
          actionIcon,
          actionRunState,
        };
        const previousPtyId = currentReplacementTab?.ptyId ?? null;

        updateSlot(environmentId, (existing) => ({
          ...existing,
          visible: true,
          tabs:
            currentReplacementTab
              ? existing.tabs.map((tab) =>
                  tab.id === currentReplacementTab.id ? nextTab : tab,
                )
              : [...existing.tabs, nextTab],
          activeTabId: nextTabId,
        }));
        if (previousPtyId && previousPtyId !== ptyId) {
          await killTerminalSession(previousPtyId);
        }
        return nextTabId;
      })();

      pendingActionTabOpens.set(operationKey, openPromise);
      try {
        return await openPromise;
      } finally {
        if (pendingActionTabOpens.get(operationKey) === openPromise) {
          pendingActionTabOpens.delete(operationKey);
        }
      }
    },

    closeTab: async (environmentId, id) => {
      const slot = get().byEnv[environmentId];
      const tab = slot?.tabs.find((t) => t.id === id);
      if (!tab) return;
      await killTerminalSession(tab.ptyId);
      updateSlot(environmentId, (existing) => {
        const tabs = existing.tabs.filter((currentTab) => currentTab.id !== id);
        return {
          ...existing,
          tabs,
          activeTabId:
            existing.activeTabId === id
              ? (tabs[tabs.length - 1]?.id ?? null)
              : existing.activeTabId,
          visible: tabs.length > 0 ? existing.visible : false,
        };
      });
    },

    activateTab: (environmentId, id) => {
      set((state) => ({
        byEnv:
          environmentId in state.byEnv
            ? {
                ...state.byEnv,
                [environmentId]: {
                  ...slotForEnvironment(state.byEnv, environmentId),
                  activeTabId: id,
                },
              }
            : state.byEnv,
      }));
    },

    markExited: (ptyId) =>
      set((state) => ({
        byEnv: mapTabsByPtyId(state.byEnv, ptyId, (tab) => ({
          ...tab,
          exited: true,
          actionRunState:
            tab.kind === "manualAction" ? "exited" : tab.actionRunState,
        })),
      })),

    syncProjectActionState: (payload) =>
      set((state) => ({
        byEnv: applyProjectActionStateEvent(state.byEnv, payload),
      })),
  };
});

export function selectTerminalSlot(environmentId: string | null) {
  return (state: TerminalState): EnvironmentTerminalSlot => {
    if (!environmentId) return EMPTY_TERMINAL_SLOT;
    return state.byEnv[environmentId] ?? EMPTY_TERMINAL_SLOT;
  };
}

export function selectHasAnyTerminalTabs(state: TerminalState): boolean {
  return Object.values(state.byEnv).some((slot) => slot.tabs.length > 0);
}

function collectEnvironmentMetadata(snapshot: WorkspaceSnapshot) {
  return new Map(
    snapshot.projects.flatMap((project) =>
      project.environments.map((environment) => [
        environment.id,
        { path: environment.path },
      ] as const),
    ),
  );
}

function reconcileTerminalSnapshot(
  state: Pick<TerminalState, "byEnv">,
  environmentIds: string[],
  ptyIdsToKill: string[],
  removedEnvironmentIds: string[],
  transformSlot?: (
    slot: EnvironmentTerminalSlot,
    environmentId: string,
  ) => EnvironmentTerminalSlot,
) {
  const validEnvironmentIds = new Set(environmentIds);
  const nextByEnv: TerminalState["byEnv"] = {};

  for (const [environmentId, rawSlot] of Object.entries(state.byEnv)) {
    const slot = normalizeSlot(rawSlot, environmentId);
    if (!validEnvironmentIds.has(environmentId)) {
      removedEnvironmentIds.push(environmentId);
      for (const tab of slot.tabs) {
        ptyIdsToKill.push(tab.ptyId);
      }
      continue;
    }

    nextByEnv[environmentId] = transformSlot
      ? transformSlot(slot, environmentId)
      : slot;
  }

  for (const environmentId of environmentIds) {
    if (environmentId in nextByEnv) {
      continue;
    }
    const slot = slotForEnvironment(nextByEnv, environmentId);
    nextByEnv[environmentId] = transformSlot
      ? transformSlot(slot, environmentId)
      : slot;
  }

  return {
    byEnv: nextByEnv,
    knownEnvironmentIds: environmentIds,
  };
}

function disposeTerminals(ptyIds: string[]) {
  for (const ptyId of ptyIds) {
    void killTerminalSession(ptyId);
  }
}
