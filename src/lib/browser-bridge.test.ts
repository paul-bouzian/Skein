import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installBrowserBridge } from "./browser-bridge";
import { useBrowserStore } from "../stores/browser-store";
import type {
  BrowserTabEventMap,
  BrowserTabEventName,
} from "./desktop-types";

type Handlers = {
  [K in BrowserTabEventName]?: (payload: BrowserTabEventMap[K]) => void;
};

function installMockDesktop(): { handlers: Handlers; unlisten: () => void } {
  const handlers: Handlers = {};
  const onTabEvent = vi.fn(
    <K extends BrowserTabEventName>(
      kind: K,
      handler: (payload: BrowserTabEventMap[K]) => void,
    ) => {
      handlers[kind] = handler as Handlers[K];
      return () => {
        delete handlers[kind];
      };
    },
  );
  (window as unknown as { skeinDesktop?: unknown }).skeinDesktop = {
    browser: {
      createTab: vi.fn(),
      destroyTab: vi.fn(),
      destroyEnv: vi.fn(),
      activateTab: vi.fn(),
      navigate: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      reload: vi.fn(),
      setPanelBounds: vi.fn(),
      openDevTools: vi.fn(),
      onTabEvent,
    },
  };
  return {
    handlers,
    unlisten: () => {
      delete (window as unknown as { skeinDesktop?: unknown }).skeinDesktop;
    },
  };
}

beforeEach(() => {
  useBrowserStore.setState({ byEnv: {} });
});

afterEach(() => {
  delete (window as unknown as { skeinDesktop?: unknown }).skeinDesktop;
});

describe("browser-bridge", () => {
  it("no-ops gracefully when the desktop API is unavailable", () => {
    expect(() => installBrowserBridge()()).not.toThrow();
  });

  it("routes did-navigate events to navigateFromMain", () => {
    const { handlers, unlisten } = installMockDesktop();
    const teardown = installBrowserBridge();
    const tabId = useBrowserStore.getState().openTab("env-a", "http://a")!;
    // Simulate the initial load settling so the page-initiated nav
    // below is treated as a fresh history step.
    useBrowserStore.getState().markPending(tabId, false);
    handlers["did-navigate"]?.({
      tabId,
      url: "http://a/deep",
      isInPlace: false,
    });
    const tab = useBrowserStore.getState().byEnv["env-a"]!.tabs[0];
    expect(tab.history).toEqual(["http://a", "http://a/deep"]);
    teardown();
    unlisten();
  });

  it("routes did-start-loading and did-stop-loading to markPending", () => {
    const { handlers, unlisten } = installMockDesktop();
    const teardown = installBrowserBridge();
    const tabId = useBrowserStore.getState().openTab("env-a", "http://a")!;
    useBrowserStore.getState().markPending(tabId, false);
    handlers["did-start-loading"]?.({ tabId });
    expect(
      useBrowserStore.getState().byEnv["env-a"]!.tabs[0].pending,
    ).toBe(true);
    handlers["did-stop-loading"]?.({ tabId });
    expect(
      useBrowserStore.getState().byEnv["env-a"]!.tabs[0].pending,
    ).toBe(false);
    teardown();
    unlisten();
  });

  it("routes page-title-updated to setTitle", () => {
    const { handlers, unlisten } = installMockDesktop();
    const teardown = installBrowserBridge();
    const tabId = useBrowserStore.getState().openTab("env-a", "http://a")!;
    handlers["page-title-updated"]?.({ tabId, title: "Hello" });
    expect(useBrowserStore.getState().byEnv["env-a"]!.tabs[0].title).toBe(
      "Hello",
    );
    teardown();
    unlisten();
  });

  it("routes page-favicon-updated to setFavicon using the first favicon", () => {
    const { handlers, unlisten } = installMockDesktop();
    const teardown = installBrowserBridge();
    const tabId = useBrowserStore.getState().openTab("env-a", "http://a")!;
    handlers["page-favicon-updated"]?.({
      tabId,
      favicons: ["http://a/favicon.ico", "http://a/other.png"],
    });
    expect(
      useBrowserStore.getState().byEnv["env-a"]!.tabs[0].favicon,
    ).toBe("http://a/favicon.ico");
    teardown();
    unlisten();
  });

  it("handles open-window-request by opening a new tab in the source env", () => {
    const { handlers, unlisten } = installMockDesktop();
    const teardown = installBrowserBridge();
    const sourceTabId = useBrowserStore
      .getState()
      .openTab("env-a", "http://a")!;
    handlers["open-window-request"]?.({
      sourceTabId,
      url: "http://b",
      disposition: "foreground-tab",
    });
    const tabs = useBrowserStore.getState().byEnv["env-a"]!.tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs[1].history[0]).toBe("http://b");
    teardown();
    unlisten();
  });
});
