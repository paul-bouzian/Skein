import { create } from "zustand";

export const MAX_BROWSER_TABS = 8;
export const DETECTED_URLS_LIMIT = 16;
export const BROWSER_HOME_URL = "about:blank";

export type BrowserTab = {
  id: string;
  history: string[];
  cursor: number;
  pending: boolean;
  title: string;
  favicon: string | null;
  // True while a renderer-issued nav (navigate/back/forward/reload) is
  // in flight waiting for the main process to emit the resolved URL.
  // Page-initiated navigations (link clicks, pushState) leave this
  // false, so the `navigateFromMain` dispatcher can tell whether to
  // replace the current history entry (renderer-initiated resolution)
  // or append a new one (page-initiated step).
  awaitingResolve: boolean;
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

  navigateFromMain: (tabId: string, url: string, isInPlace: boolean) => void;
  setTitle: (tabId: string, title: string) => void;
  setFavicon: (tabId: string, favicon: string | null) => void;
  markPending: (tabId: string, pending: boolean) => void;

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

// Return a canonical form suitable for equality checks. `new URL()`
// normalizes trailing slashes, default ports, percent-encoding, and
// case-insensitive host, so two URLs that differ only by those forms
// are treated as the same entry in the tab history.
function canonicalUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function buildTab(initialUrl: string): BrowserTab {
  const isBlank = initialUrl === BROWSER_HOME_URL;
  return {
    id: crypto.randomUUID(),
    history: [initialUrl],
    cursor: 0,
    pending: !isBlank,
    title: hostFromUrl(initialUrl),
    favicon: null,
    awaitingResolve: !isBlank,
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

export function findEnvIdForTab(
  byEnv: Record<string, BrowserEnvSlot>,
  tabId: string,
): string | null {
  for (const [envId, slot] of Object.entries(byEnv)) {
    if (slot.tabs.some((tab) => tab.id === tabId)) return envId;
  }
  return null;
}

function updateTabById(
  state: BrowserState,
  tabId: string,
  patcher: (tab: BrowserTab) => BrowserTab | null,
): Partial<BrowserState> | null {
  const envId = findEnvIdForTab(state.byEnv, tabId);
  if (!envId) return null;
  return updateSlot(state, envId, (slot) => {
    let changed = false;
    const nextTabs = slot.tabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      const next = patcher(tab);
      if (next === null || next === tab) return tab;
      changed = true;
      return next;
    });
    if (!changed) return null;
    return { ...slot, tabs: nextTabs };
  });
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
          awaitingResolve: true,
          title: hostFromUrl(url),
          favicon: null,
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
          awaitingResolve: true,
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
          awaitingResolve: true,
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
            ? { ...tab, pending: true, awaitingResolve: true }
            : tab,
        ),
      };
    });
    if (patch) set(patch);
  },

  navigateFromMain: (tabId, url, isInPlace) => {
    const patch = updateTabById(get(), tabId, (tab) => {
      const currentUrl = tab.history[tab.cursor] ?? "";
      const sameEntry = canonicalUrl(currentUrl) === canonicalUrl(url);
      // Replace-in-place when:
      //  - the main process flagged the nav as in-page (`pushState`), or
      //  - the renderer asked for this nav (`awaitingResolve`) and the
      //    resolved URL is the same slot: a redirect/canonicalization
      //    of what the user typed or of the back/forward target.
      // Every other `did-navigate` is a page-initiated step (link click,
      // script navigation) and should append to history so Back still
      // works.
      const shouldReplace = isInPlace || tab.awaitingResolve;
      if (shouldReplace) {
        if (sameEntry && !tab.awaitingResolve) return null;
        const nextHistory = tab.history.slice();
        nextHistory[tab.cursor] = url;
        return {
          ...tab,
          history: nextHistory,
          title: hostFromUrl(url),
          awaitingResolve: false,
          // In-page navigations never emit `did-stop-loading`, so clear
          // `pending` here. Full loads will clear it via that event.
          pending: isInPlace ? false : tab.pending,
        };
      }
      if (sameEntry) return null;
      const trimmed = tab.history.slice(0, tab.cursor + 1);
      const nextHistory = [...trimmed, url];
      return {
        ...tab,
        history: nextHistory,
        cursor: nextHistory.length - 1,
        title: hostFromUrl(url),
        favicon: null,
      };
    });
    if (patch) set(patch);
  },

  setTitle: (tabId, title) => {
    const patch = updateTabById(get(), tabId, (tab) => {
      if (!title || tab.title === title) return null;
      return { ...tab, title };
    });
    if (patch) set(patch);
  },

  setFavicon: (tabId, favicon) => {
    const patch = updateTabById(get(), tabId, (tab) => {
      if (tab.favicon === favicon) return null;
      return { ...tab, favicon };
    });
    if (patch) set(patch);
  },

  markPending: (tabId, pending) => {
    const patch = updateTabById(get(), tabId, (tab) => {
      // When loading stops, also clear the renderer-initiated flag so a
      // subsequent page-initiated link click isn't mistaken for the
      // resolution of a stale user action (e.g. a failed loadURL that
      // only emitted did-fail-load + did-stop-loading, no did-navigate).
      const nextAwaiting = pending ? tab.awaitingResolve : false;
      if (tab.pending === pending && tab.awaitingResolve === nextAwaiting) {
        return null;
      }
      return { ...tab, pending, awaitingResolve: nextAwaiting };
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
