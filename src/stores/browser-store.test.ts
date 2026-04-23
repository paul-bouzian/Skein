import { beforeEach, describe, expect, it } from "vitest";

import {
  BROWSER_HOME_URL,
  DETECTED_URLS_LIMIT,
  MAX_BROWSER_TABS,
  hostFromUrl,
  selectBrowserSlot,
  selectCanGoBack,
  selectCanGoForward,
  selectCurrentUrl,
  useBrowserStore,
} from "./browser-store";

const ENV = "env-a";

function slot() {
  return selectBrowserSlot(ENV)(useBrowserStore.getState());
}

beforeEach(() => {
  useBrowserStore.setState({ byEnv: {} });
});

describe("hostFromUrl", () => {
  it("returns host for valid URLs", () => {
    expect(hostFromUrl("http://localhost:3000/foo")).toBe("localhost:3000");
  });

  it("returns placeholder for blank", () => {
    expect(hostFromUrl(BROWSER_HOME_URL)).toBe("New tab");
  });

  it("returns the raw string for invalid URLs", () => {
    expect(hostFromUrl("not a url")).toBe("not a url");
  });
});

describe("browser-store: tabs", () => {
  it("openTab creates a tab with history and marks it active", () => {
    const id = useBrowserStore.getState().openTab(ENV, "http://localhost:3000");
    expect(id).not.toBeNull();
    const s = slot();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe(id);
    expect(s.tabs[0].history).toEqual(["http://localhost:3000"]);
    expect(s.tabs[0].cursor).toBe(0);
    expect(s.tabs[0].pending).toBe(true);
  });

  it("openTab with no URL uses BROWSER_HOME_URL and pending=false", () => {
    const id = useBrowserStore.getState().openTab(ENV);
    const tab = slot().tabs.find((t) => t.id === id);
    expect(tab?.history[0]).toBe(BROWSER_HOME_URL);
    expect(tab?.pending).toBe(false);
  });

  it("openTab returns null when MAX_BROWSER_TABS reached", () => {
    for (let i = 0; i < MAX_BROWSER_TABS; i++) {
      expect(useBrowserStore.getState().openTab(ENV)).not.toBeNull();
    }
    expect(useBrowserStore.getState().openTab(ENV)).toBeNull();
  });

  it("closeTab removes tab and picks a sensible next active", () => {
    const a = useBrowserStore.getState().openTab(ENV, "http://a");
    const b = useBrowserStore.getState().openTab(ENV, "http://b");
    const c = useBrowserStore.getState().openTab(ENV, "http://c");
    expect(slot().activeTabId).toBe(c);
    useBrowserStore.getState().closeTab(ENV, c!);
    expect(slot().activeTabId).toBe(b);
    useBrowserStore.getState().closeTab(ENV, a!);
    expect(slot().activeTabId).toBe(b);
    useBrowserStore.getState().closeTab(ENV, b!);
    expect(slot().activeTabId).toBeNull();
  });

  it("activateTab switches the active tab", () => {
    const a = useBrowserStore.getState().openTab(ENV, "http://a");
    const b = useBrowserStore.getState().openTab(ENV, "http://b");
    expect(slot().activeTabId).toBe(b);
    useBrowserStore.getState().activateTab(ENV, a!);
    expect(slot().activeTabId).toBe(a);
  });
});

describe("browser-store: navigation", () => {
  it("navigate pushes URL to history and advances cursor", () => {
    useBrowserStore.getState().openTab(ENV, "http://a");
    useBrowserStore.getState().navigate(ENV, "http://b");
    const tab = slot().tabs[0];
    expect(tab.history).toEqual(["http://a", "http://b"]);
    expect(tab.cursor).toBe(1);
    expect(selectCurrentUrl(slot())).toBe("http://b");
  });

  it("back/forward move the cursor without mutating history", () => {
    useBrowserStore.getState().openTab(ENV, "http://a");
    useBrowserStore.getState().navigate(ENV, "http://b");
    useBrowserStore.getState().navigate(ENV, "http://c");

    useBrowserStore.getState().back(ENV);
    expect(selectCurrentUrl(slot())).toBe("http://b");
    expect(selectCanGoBack(slot())).toBe(true);
    expect(selectCanGoForward(slot())).toBe(true);

    useBrowserStore.getState().forward(ENV);
    expect(selectCurrentUrl(slot())).toBe("http://c");
    expect(selectCanGoForward(slot())).toBe(false);
  });

  it("navigate after back truncates forward history", () => {
    useBrowserStore.getState().openTab(ENV, "http://a");
    useBrowserStore.getState().navigate(ENV, "http://b");
    useBrowserStore.getState().navigate(ENV, "http://c");
    useBrowserStore.getState().back(ENV);
    useBrowserStore.getState().navigate(ENV, "http://d");
    expect(slot().tabs[0].history).toEqual([
      "http://a",
      "http://b",
      "http://d",
    ]);
    expect(selectCanGoForward(slot())).toBe(false);
  });

  it("reload marks the active tab as pending", () => {
    useBrowserStore.getState().openTab(ENV, "http://a");
    useBrowserStore.getState().markPending(slot().tabs[0].id, false);
    expect(slot().tabs[0].pending).toBe(false);
    useBrowserStore.getState().reload(ENV);
    expect(slot().tabs[0].pending).toBe(true);
  });

  it("back is no-op at cursor=0", () => {
    useBrowserStore.getState().openTab(ENV, "http://a");
    useBrowserStore.getState().back(ENV);
    expect(slot().tabs[0].cursor).toBe(0);
  });
});

describe("browser-store: detectedUrls per env", () => {
  it("reportDetectedUrl dedups and orders most-recent first within an env", () => {
    useBrowserStore.getState().reportDetectedUrl(ENV, "http://localhost:3000");
    useBrowserStore.getState().reportDetectedUrl(ENV, "http://localhost:5173");
    useBrowserStore.getState().reportDetectedUrl(ENV, "http://localhost:3000");
    const urls = slot().detectedUrls.map((entry) => entry.url);
    expect(urls).toEqual([
      "http://localhost:3000",
      "http://localhost:5173",
    ]);
  });

  it("detected URLs are isolated per env", () => {
    useBrowserStore.getState().reportDetectedUrl("env-a", "http://localhost:3000");
    useBrowserStore.getState().reportDetectedUrl("env-b", "http://localhost:5173");
    const envA = selectBrowserSlot("env-a")(useBrowserStore.getState());
    const envB = selectBrowserSlot("env-b")(useBrowserStore.getState());
    expect(envA.detectedUrls.map((d) => d.url)).toEqual([
      "http://localhost:3000",
    ]);
    expect(envB.detectedUrls.map((d) => d.url)).toEqual([
      "http://localhost:5173",
    ]);
  });

  it("caps at DETECTED_URLS_LIMIT per env", () => {
    for (let i = 0; i < DETECTED_URLS_LIMIT + 4; i++) {
      useBrowserStore.getState().reportDetectedUrl(ENV, `http://localhost:${i}`);
    }
    expect(slot().detectedUrls).toHaveLength(DETECTED_URLS_LIMIT);
  });
});

describe("browser-store: tabs are isolated per env", () => {
  it("opening a tab in env-a does not affect env-b", () => {
    useBrowserStore.getState().openTab("env-a", "http://a");
    expect(selectBrowserSlot("env-b")(useBrowserStore.getState()).tabs).toEqual(
      [],
    );
  });
});

describe("browser-store: session-only", () => {
  it("does not persist tabs to localStorage", async () => {
    useBrowserStore.getState().openTab(ENV, "http://a");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const keys = Object.keys(localStorage).filter((key) =>
      key.includes("browser"),
    );
    expect(keys).toEqual([]);
  });
});

describe("browser-store: events from main process", () => {
  it("navigateFromMain appends a new URL to the tab's history", () => {
    const id = useBrowserStore.getState().openTab(ENV, "http://a");
    // Simulate the initial load settling so a subsequent page-initiated
    // navigation is treated as a fresh history step, not a replace.
    useBrowserStore.getState().markPending(id!, false);
    useBrowserStore.getState().navigateFromMain(id!, "http://b", false);
    const tab = slot().tabs[0];
    expect(tab.history).toEqual(["http://a", "http://b"]);
    expect(tab.cursor).toBe(1);
  });

  it("navigateFromMain dedupes when the URL matches the current one", () => {
    const id = useBrowserStore.getState().openTab(ENV, "http://a");
    useBrowserStore.getState().navigateFromMain(id!, "http://a", false);
    const tab = slot().tabs[0];
    expect(tab.history).toEqual(["http://a"]);
    expect(tab.cursor).toBe(0);
  });

  it("navigateFromMain truncates forward history when navigating after back", () => {
    const id = useBrowserStore.getState().openTab(ENV, "http://a");
    useBrowserStore.getState().navigate(ENV, "http://b");
    useBrowserStore.getState().navigate(ENV, "http://c");
    useBrowserStore.getState().back(ENV);
    useBrowserStore.getState().markPending(id!, false);
    useBrowserStore.getState().navigateFromMain(id!, "http://d", false);
    expect(slot().tabs[0].history).toEqual(["http://a", "http://b", "http://d"]);
  });

  it("navigateFromMain replaces the pending entry when a user-initiated nav redirects", () => {
    const id = useBrowserStore.getState().openTab(ENV, "http://example.com");
    // User typed the URL → store.navigate pushed, awaitingResolve=true.
    expect(slot().tabs[0].awaitingResolve).toBe(true);
    // Main process resolved it to the https redirect.
    useBrowserStore
      .getState()
      .navigateFromMain(id!, "https://example.com/", false);
    const tab = slot().tabs[0];
    expect(tab.history).toEqual(["https://example.com/"]);
    expect(tab.cursor).toBe(0);
    expect(tab.awaitingResolve).toBe(false);
  });

  it("navigateFromMain appends on page-initiated link click even if pending is true", () => {
    const id = useBrowserStore.getState().openTab(ENV, "http://a");
    // Initial load settles — pending + awaitingResolve cleared.
    useBrowserStore.getState().markPending(id!, false);
    // The page starts loading a link the user clicked: did-start-loading
    // sets pending=true but leaves awaitingResolve=false.
    useBrowserStore.getState().markPending(id!, true);
    expect(slot().tabs[0].awaitingResolve).toBe(false);
    useBrowserStore.getState().navigateFromMain(id!, "http://b", false);
    const tab = slot().tabs[0];
    expect(tab.history).toEqual(["http://a", "http://b"]);
    expect(tab.cursor).toBe(1);
  });

  it("navigateFromMain replaces the current entry when isInPlace=true", () => {
    const id = useBrowserStore.getState().openTab(ENV, "http://a/p1");
    useBrowserStore.getState().navigateFromMain(id!, "http://a/p2", true);
    const tab = slot().tabs[0];
    expect(tab.history).toEqual(["http://a/p2"]);
    expect(tab.cursor).toBe(0);
  });

  it("setTitle updates a tab title", () => {
    const id = useBrowserStore.getState().openTab(ENV, "http://a");
    useBrowserStore.getState().setTitle(id!, "My Page");
    expect(slot().tabs[0].title).toBe("My Page");
  });

  it("setTitle no-ops on empty titles", () => {
    const id = useBrowserStore.getState().openTab(ENV, "http://a");
    const before = slot().tabs[0].title;
    useBrowserStore.getState().setTitle(id!, "");
    expect(slot().tabs[0].title).toBe(before);
  });

  it("setFavicon stores a favicon URL and clears it", () => {
    const id = useBrowserStore.getState().openTab(ENV, "http://a");
    useBrowserStore.getState().setFavicon(id!, "http://a/favicon.ico");
    expect(slot().tabs[0].favicon).toBe("http://a/favicon.ico");
    useBrowserStore.getState().setFavicon(id!, null);
    expect(slot().tabs[0].favicon).toBeNull();
  });

  it("markPending toggles the pending flag", () => {
    const id = useBrowserStore.getState().openTab(ENV, "http://a");
    expect(slot().tabs[0].pending).toBe(true);
    useBrowserStore.getState().markPending(id!, false);
    expect(slot().tabs[0].pending).toBe(false);
    useBrowserStore.getState().markPending(id!, true);
    expect(slot().tabs[0].pending).toBe(true);
  });

  it("ignores events for an unknown tabId", () => {
    useBrowserStore.getState().openTab(ENV, "http://a");
    const before = slot();
    useBrowserStore
      .getState()
      .navigateFromMain(
        "00000000-0000-4000-8000-000000000000",
        "http://unknown",
        false,
      );
    expect(slot()).toBe(before);
  });
});
