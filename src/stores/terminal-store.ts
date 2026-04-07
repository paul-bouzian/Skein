import { create } from "zustand";

import * as bridge from "../lib/bridge";

const HEIGHT_KEY = "threadex-terminal-height";
const VISIBLE_KEY = "threadex-terminal-visible";
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 120;
export const MAX_TABS = 10;

function readHeight(): number {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY));
    if (Number.isFinite(value) && value >= MIN_HEIGHT) return value;
  } catch {
    /* ignore */
  }
  return DEFAULT_HEIGHT;
}

function readVisible(): boolean {
  try {
    return localStorage.getItem(VISIBLE_KEY) === "1";
  } catch {
    return false;
  }
}

function clampHeight(value: number): number {
  const max = Math.floor(window.innerHeight * 0.8);
  return Math.max(MIN_HEIGHT, Math.min(value, max));
}

function basenameOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "shell";
}

export type TerminalTab = {
  id: string;
  ptyId: string;
  title: string;
  cwd: string;
  exited: boolean;
};

type TerminalState = {
  visible: boolean;
  height: number;
  tabs: TerminalTab[];
  activeTabId: string | null;
  toggleVisible: () => void;
  setVisible: (visible: boolean) => void;
  setHeight: (value: number) => void;
  openTab: (cwd: string) => Promise<string | null>;
  closeTab: (id: string) => Promise<void>;
  activateTab: (id: string) => void;
  markExited: (ptyId: string) => void;
};

export const useTerminalStore = create<TerminalState>((set, get) => ({
  visible: readVisible(),
  height: readHeight(),
  tabs: [],
  activeTabId: null,

  toggleVisible: () => {
    const next = !get().visible;
    localStorage.setItem(VISIBLE_KEY, next ? "1" : "0");
    set({ visible: next });
  },

  setVisible: (visible) => {
    localStorage.setItem(VISIBLE_KEY, visible ? "1" : "0");
    set({ visible });
  },

  setHeight: (value) => {
    const clamped = clampHeight(value);
    localStorage.setItem(HEIGHT_KEY, String(clamped));
    set({ height: clamped });
  },

  openTab: async (cwd) => {
    if (get().tabs.length >= MAX_TABS) return null;
    // Generous defaults; FitAddon will resize immediately after mount.
    const { ptyId } = await bridge.spawnTerminal({ cwd, cols: 80, rows: 24 });
    const id = crypto.randomUUID();
    set((state) => ({
      tabs: [
        ...state.tabs,
        { id, ptyId, cwd, title: basenameOf(cwd), exited: false },
      ],
      activeTabId: id,
    }));
    return id;
  },

  closeTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    try {
      await bridge.killTerminal({ ptyId: tab.ptyId });
    } catch {
      /* ignore: terminal may already be dead */
    }
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id);
      const activeTabId =
        state.activeTabId === id
          ? (tabs[tabs.length - 1]?.id ?? null)
          : state.activeTabId;
      // Closing the last tab closes the whole panel.
      if (tabs.length === 0) {
        localStorage.setItem(VISIBLE_KEY, "0");
        return { tabs, activeTabId, visible: false };
      }
      return { tabs, activeTabId };
    });
  },

  activateTab: (id) => set({ activeTabId: id }),

  markExited: (ptyId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.ptyId === ptyId ? { ...tab, exited: true } : tab,
      ),
    })),
}));
