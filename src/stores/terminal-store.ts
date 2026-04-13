import { create } from "zustand";

import {
  LEGACY_TERMINAL_HEIGHT_STORAGE_KEYS,
  LEGACY_TERMINAL_VISIBLE_STORAGE_KEYS,
  TERMINAL_HEIGHT_STORAGE_KEY,
  TERMINAL_VISIBLE_STORAGE_KEY,
  readLocalStorageWithMigration,
} from "../lib/app-identity";
import * as bridge from "../lib/bridge";
import type { WorkspaceSnapshot } from "../lib/types";
import {
  dropPendingTerminalOutput,
  ensureTerminalOutputBusReady,
} from "../lib/terminal-output-bus";

const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 120;
export const MAX_TABS = 10;

function clampHeight(value: number): number {
  const max = Math.floor(window.innerHeight * 0.8);
  return Math.max(MIN_HEIGHT, Math.min(value, max));
}

function readHeight(): number {
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

function readVisible(): boolean {
  try {
    return (
      readLocalStorageWithMigration(
        TERMINAL_VISIBLE_STORAGE_KEY,
        LEGACY_TERMINAL_VISIBLE_STORAGE_KEYS,
      ) === "1"
    );
  } catch {
    return false;
  }
}

function basenameOf(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? "shell";
}

export type TerminalTab = {
  id: string;
  ptyId: string;
  title: string;
  cwd: string;
  exited: boolean;
};

export type EnvironmentTerminalSlot = {
  tabs: TerminalTab[];
  activeTabId: string | null;
};

export const EMPTY_TERMINAL_SLOT: EnvironmentTerminalSlot = Object.freeze({
  tabs: [],
  activeTabId: null,
});

type TerminalState = {
  visible: boolean;
  height: number;
  // Tabs are keyed by environmentId so the panel always shows shells started
  // inside the currently selected worktree. Switching environments swaps the
  // visible tab list; PTYs from inactive environments stay alive in the
  // background until their tabs are explicitly closed.
  byEnv: Record<string, EnvironmentTerminalSlot>;
  knownEnvironmentIds: string[];

  toggleVisible: () => void;
  setVisible: (visible: boolean) => void;
  setHeight: (value: number) => void;
  reconcileEnvironments: (environmentIds: string[]) => void;
  syncWorkspaceSnapshot: (snapshot: WorkspaceSnapshot) => void;

  openTab: (environmentId: string) => Promise<string | null>;
  closeTab: (environmentId: string, id: string) => Promise<void>;
  activateTab: (environmentId: string, id: string) => void;
  markExited: (ptyId: string) => void;
};

export const useTerminalStore = create<TerminalState>((set, get) => ({
  visible: readVisible(),
  height: readHeight(),
  byEnv: {},
  knownEnvironmentIds: [],

  toggleVisible: () => {
    const next = !get().visible;
    localStorage.setItem(TERMINAL_VISIBLE_STORAGE_KEY, next ? "1" : "0");
    set({ visible: next });
  },

  setVisible: (visible) => {
    localStorage.setItem(TERMINAL_VISIBLE_STORAGE_KEY, visible ? "1" : "0");
    set({ visible });
  },

  setHeight: (value) => {
    const clamped = clampHeight(value);
    localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(clamped));
    set({ height: clamped });
  },

  reconcileEnvironments: (environmentIds) => {
    const ptyIdsToKill: string[] = [];
    set((state) =>
      reconcileTerminalSnapshot(state, environmentIds, ptyIdsToKill),
    );
    disposeTerminals(ptyIdsToKill);
  },

  syncWorkspaceSnapshot: (snapshot) => {
    const metadataByEnv = collectEnvironmentMetadata(snapshot);
    const environmentIds = [...metadataByEnv.keys()];
    const ptyIdsToKill: string[] = [];

    set((state) =>
      reconcileTerminalSnapshot(state, environmentIds, ptyIdsToKill, (slot, environmentId) => {
        const metadata = metadataByEnv.get(environmentId);
        if (!metadata) {
          return slot;
        }

        return {
          ...slot,
          tabs: slot.tabs.map((tab) => ({
            ...tab,
            cwd: metadata.path,
            title: basenameOf(metadata.path),
          })),
        };
      }),
    );

    disposeTerminals(ptyIdsToKill);
  },

  openTab: async (environmentId) => {
    const slot = get().byEnv[environmentId] ?? EMPTY_TERMINAL_SLOT;
    if (slot.tabs.length >= MAX_TABS) return null;
    // Attach the output bus BEFORE spawning so any bytes emitted between
    // spawn and the TerminalView subscribe are buffered, not dropped.
    await ensureTerminalOutputBusReady();
    // Generous defaults; FitAddon will resize immediately after mount.
    const { ptyId, cwd } = await bridge.spawnTerminal({
      environmentId,
      cols: 80,
      rows: 24,
    });
    // Re-check the cap after the async spawn: concurrent openTab calls can
    // both pass the initial check. If we raced past the cap, kill the PTY we
    // just created and bail.
    const slotAfter = get().byEnv[environmentId] ?? EMPTY_TERMINAL_SLOT;
    const knownEnvironmentIds = get().knownEnvironmentIds;
    const environmentKnown =
      knownEnvironmentIds.length === 0 ||
      knownEnvironmentIds.includes(environmentId);
    if (!environmentKnown || slotAfter.tabs.length >= MAX_TABS) {
      try {
        await bridge.killTerminal({ ptyId });
      } catch {
        /* ignore: terminal may already be dead */
      }
      dropPendingTerminalOutput(ptyId);
      return null;
    }
    const id = crypto.randomUUID();
    set((state) => {
      const existing = state.byEnv[environmentId] ?? EMPTY_TERMINAL_SLOT;
      return {
        byEnv: {
          ...state.byEnv,
          [environmentId]: {
            tabs: [
              ...existing.tabs,
              { id, ptyId, cwd, title: basenameOf(cwd), exited: false },
            ],
            activeTabId: id,
          },
        },
      };
    });
    return id;
  },

  closeTab: async (environmentId, id) => {
    const slot = get().byEnv[environmentId];
    const tab = slot?.tabs.find((t) => t.id === id);
    if (!tab) return;
    try {
      await bridge.killTerminal({ ptyId: tab.ptyId });
    } catch {
      /* ignore: terminal may already be dead */
    }
    dropPendingTerminalOutput(tab.ptyId);
    set((state) => {
      const existing = state.byEnv[environmentId];
      if (!existing) return state;
      const tabs = existing.tabs.filter((t) => t.id !== id);
      const activeTabId =
        existing.activeTabId === id
          ? (tabs[tabs.length - 1]?.id ?? null)
          : existing.activeTabId;
      // Closing the last tab in this env removes the empty slot so byEnv
      // doesn't grow forever. Hide the panel only when no terminals remain
      // anywhere in the workspace.
      if (tabs.length === 0) {
        const nextByEnv = { ...state.byEnv };
        delete nextByEnv[environmentId];
        const hasTabsRemaining = Object.values(nextByEnv).some(
          (slot) => slot.tabs.length > 0,
        );
        if (!hasTabsRemaining) {
          localStorage.setItem(TERMINAL_VISIBLE_STORAGE_KEY, "0");
        }
        return { byEnv: nextByEnv, visible: hasTabsRemaining ? state.visible : false };
      }
      return {
        byEnv: {
          ...state.byEnv,
          [environmentId]: { tabs, activeTabId },
        },
      };
    });
  },

  activateTab: (environmentId, id) =>
    set((state) => {
      const existing = state.byEnv[environmentId];
      if (!existing) return state;
      return {
        byEnv: {
          ...state.byEnv,
          [environmentId]: { ...existing, activeTabId: id },
        },
      };
    }),

  markExited: (ptyId) =>
    set((state) => ({
      byEnv: Object.fromEntries(
        Object.entries(state.byEnv).map(([envId, slot]) => [
          envId,
          {
            ...slot,
            tabs: slot.tabs.map((tab) =>
              tab.ptyId === ptyId ? { ...tab, exited: true } : tab,
            ),
          },
        ]),
      ),
    })),
}));

export function selectTerminalSlot(environmentId: string | null) {
  return (state: TerminalState): EnvironmentTerminalSlot => {
    if (!environmentId) return EMPTY_TERMINAL_SLOT;
    return state.byEnv[environmentId] ?? EMPTY_TERMINAL_SLOT;
  };
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
  state: Pick<TerminalState, "byEnv" | "visible">,
  environmentIds: string[],
  ptyIdsToKill: string[],
  transformSlot?: (
    slot: EnvironmentTerminalSlot,
    environmentId: string,
  ) => EnvironmentTerminalSlot,
) {
  const validEnvironmentIds = new Set(environmentIds);
  const nextByEnv: TerminalState["byEnv"] = {};

  for (const [environmentId, slot] of Object.entries(state.byEnv)) {
    if (!validEnvironmentIds.has(environmentId)) {
      for (const tab of slot.tabs) {
        ptyIdsToKill.push(tab.ptyId);
      }
      continue;
    }

    nextByEnv[environmentId] = transformSlot
      ? transformSlot(slot, environmentId)
      : slot;
  }

  const visible = validEnvironmentIds.size === 0 ? false : state.visible;
  if (!visible && validEnvironmentIds.size === 0) {
    localStorage.setItem(TERMINAL_VISIBLE_STORAGE_KEY, "0");
  }

  return {
    byEnv: nextByEnv,
    knownEnvironmentIds: environmentIds,
    visible,
  };
}

function disposeTerminals(ptyIds: string[]) {
  for (const ptyId of ptyIds) {
    void bridge
      .killTerminal({ ptyId })
      .catch(() => {
        /* ignore: terminal may already be dead */
      })
      .finally(() => {
        dropPendingTerminalOutput(ptyId);
      });
  }
}
