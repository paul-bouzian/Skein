import { create } from "zustand";

export const MAX_BROWSER_TABS = 8;
export const DETECTED_URLS_LIMIT = 16;
export const BROWSER_HOME_URL = "about:blank";

export type BrowserTab = {
  id: string;
  history: string[];
  cursor: number;
  reloadNonce: number;
  pending: boolean;
  title: string;
};

export type DetectedUrl = {
  url: string;
  firstSeenAt: number;
};

export type BrowserEnvSlot = {
  tabs: BrowserTab[];
  activeTabId: string | null;
  detectedUrls: DetectedUrl[];
};

export const EMPTY_BROWSER_SLOT: BrowserEnvSlot = Object.freeze({
  tabs: [],
  activeTabId: null,
  detectedUrls: [],
}) as BrowserEnvSlot;

type BrowserState = {
  byEnv: Record<string, BrowserEnvSlot>;

  openTab: (environmentId: string, url?: string) => string | null;
  closeTab: (environmentId: string, id: string) => void;
  activateTab: (environmentId: string, id: string) => void;

  navigate: (environmentId: string, url: string) => void;
  back: (environmentId: string) => void;
  forward: (environmentId: string) => void;
  reload: (environmentId: string) => void;
  markLoaded: (environmentId: string, tabId: string) => void;

  reportDetectedUrl: (environmentId: string, url: string) => void;
};

export function hostFromUrl(url: string): string {
  if (!url || url === BROWSER_HOME_URL) return "New tab";
  try {
    const parsed = new URL(url);
    return parsed.host || url;
  } catch {
    return url;
  }
}

function buildTab(initialUrl: string): BrowserTab {
  return {
    id: crypto.randomUUID(),
    history: [initialUrl],
    cursor: 0,
    reloadNonce: 0,
    pending: initialUrl !== BROWSER_HOME_URL,
    title: hostFromUrl(initialUrl),
  };
}

function emptySlot(): BrowserEnvSlot {
  return { tabs: [], activeTabId: null, detectedUrls: [] };
}

function updateSlot(
  state: BrowserState,
  environmentId: string,
  update: (slot: BrowserEnvSlot) => BrowserEnvSlot | null,
): Partial<BrowserState> | null {
  const current = state.byEnv[environmentId] ?? emptySlot();
  const next = update(current);
  if (next === null || next === current) return null;
  return { byEnv: { ...state.byEnv, [environmentId]: next } };
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  byEnv: {},

  openTab: (environmentId, url) => {
    const slot = get().byEnv[environmentId] ?? emptySlot();
    if (slot.tabs.length >= MAX_BROWSER_TABS) {
      return null;
    }
    const resolvedUrl =
      url ?? slot.detectedUrls[0]?.url ?? BROWSER_HOME_URL;
    const tab = buildTab(resolvedUrl);
    const nextSlot: BrowserEnvSlot = {
      ...slot,
      tabs: [...slot.tabs, tab],
      activeTabId: tab.id,
    };
    set((state) => ({
      byEnv: { ...state.byEnv, [environmentId]: nextSlot },
    }));
    return tab.id;
  },

  closeTab: (environmentId, id) => {
    const patch = updateSlot(get(), environmentId, (slot) => {
      const index = slot.tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return null;
      const nextTabs = slot.tabs.filter((tab) => tab.id !== id);
      let nextActive = slot.activeTabId;
      if (slot.activeTabId === id) {
        const fallback = nextTabs[index] ?? nextTabs[index - 1] ?? null;
        nextActive = fallback ? fallback.id : null;
      }
      return { ...slot, tabs: nextTabs, activeTabId: nextActive };
    });
    if (patch) set(patch);
  },

  activateTab: (environmentId, id) => {
    const patch = updateSlot(get(), environmentId, (slot) => {
      if (slot.activeTabId === id) return null;
      if (!slot.tabs.some((tab) => tab.id === id)) return null;
      return { ...slot, activeTabId: id };
    });
    if (patch) set(patch);
  },

  navigate: (environmentId, url) => {
    const patch = updateSlot(get(), environmentId, (slot) => {
      const activeId = slot.activeTabId;
      if (!activeId) return null;
      const nextTabs = slot.tabs.map((tab) => {
        if (tab.id !== activeId) return tab;
        const trimmed = tab.history.slice(0, tab.cursor + 1);
        const nextHistory = [...trimmed, url];
        return {
          ...tab,
          history: nextHistory,
          cursor: nextHistory.length - 1,
          pending: true,
          title: hostFromUrl(url),
        };
      });
      return { ...slot, tabs: nextTabs };
    });
    if (patch) set(patch);
  },

  back: (environmentId) => {
    const patch = updateSlot(get(), environmentId, (slot) => {
      const activeId = slot.activeTabId;
      if (!activeId) return null;
      const nextTabs = slot.tabs.map((tab) => {
        if (tab.id !== activeId || tab.cursor <= 0) return tab;
        const nextCursor = tab.cursor - 1;
        return {
          ...tab,
          cursor: nextCursor,
          pending: true,
          title: hostFromUrl(tab.history[nextCursor] ?? ""),
        };
      });
      return { ...slot, tabs: nextTabs };
    });
    if (patch) set(patch);
  },

  forward: (environmentId) => {
    const patch = updateSlot(get(), environmentId, (slot) => {
      const activeId = slot.activeTabId;
      if (!activeId) return null;
      const nextTabs = slot.tabs.map((tab) => {
        if (tab.id !== activeId || tab.cursor >= tab.history.length - 1) {
          return tab;
        }
        const nextCursor = tab.cursor + 1;
        return {
          ...tab,
          cursor: nextCursor,
          pending: true,
          title: hostFromUrl(tab.history[nextCursor] ?? ""),
        };
      });
      return { ...slot, tabs: nextTabs };
    });
    if (patch) set(patch);
  },

  reload: (environmentId) => {
    const patch = updateSlot(get(), environmentId, (slot) => {
      const activeId = slot.activeTabId;
      if (!activeId) return null;
      return {
        ...slot,
        tabs: slot.tabs.map((tab) =>
          tab.id === activeId
            ? { ...tab, reloadNonce: tab.reloadNonce + 1, pending: true }
            : tab,
        ),
      };
    });
    if (patch) set(patch);
  },

  markLoaded: (environmentId, tabId) => {
    const patch = updateSlot(get(), environmentId, (slot) => {
      if (!slot.tabs.some((tab) => tab.id === tabId && tab.pending)) {
        return null;
      }
      return {
        ...slot,
        tabs: slot.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, pending: false } : tab,
        ),
      };
    });
    if (patch) set(patch);
  },

  reportDetectedUrl: (environmentId, url) => {
    if (!url) return;
    const patch = updateSlot(get(), environmentId, (slot) => {
      const existing = slot.detectedUrls.filter((entry) => entry.url !== url);
      const next: DetectedUrl[] = [
        { url, firstSeenAt: Date.now() },
        ...existing,
      ].slice(0, DETECTED_URLS_LIMIT);
      return { ...slot, detectedUrls: next };
    });
    if (patch) set(patch);
  },
}));

export function selectBrowserSlot(environmentId: string | null) {
  return (state: BrowserState): BrowserEnvSlot => {
    if (!environmentId) return EMPTY_BROWSER_SLOT;
    return state.byEnv[environmentId] ?? EMPTY_BROWSER_SLOT;
  };
}

export function selectActiveTab(slot: BrowserEnvSlot): BrowserTab | null {
  if (!slot.activeTabId) return null;
  return slot.tabs.find((tab) => tab.id === slot.activeTabId) ?? null;
}

export function selectCurrentUrl(slot: BrowserEnvSlot): string | null {
  const tab = selectActiveTab(slot);
  if (!tab) return null;
  return tab.history[tab.cursor] ?? null;
}

export function selectCanGoBack(slot: BrowserEnvSlot): boolean {
  const tab = selectActiveTab(slot);
  return tab ? tab.cursor > 0 : false;
}

export function selectCanGoForward(slot: BrowserEnvSlot): boolean {
  const tab = selectActiveTab(slot);
  return tab ? tab.cursor < tab.history.length - 1 : false;
}
