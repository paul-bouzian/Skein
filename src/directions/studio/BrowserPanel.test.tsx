import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  makeEnvironment,
  makeProject,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import {
  selectBrowserSlot,
  useBrowserStore,
} from "../../stores/browser-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { BrowserPanel } from "./BrowserPanel";


const ENV = "env-a";

function slot() {
  return selectBrowserSlot(ENV)(useBrowserStore.getState());
}

function selectEnvironment(): void {
  useWorkspaceStore.setState({
    selectedEnvironmentId: ENV,
    selectedProjectId: "project-a",
  } as Partial<ReturnType<typeof useWorkspaceStore.getState>>);
}

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver =
    NoopResizeObserver;
}

const storageState = new Map<string, string>();

type BrowserApiMock = {
  createTab: ReturnType<typeof vi.fn>;
  destroyTab: ReturnType<typeof vi.fn>;
  destroyEnv: ReturnType<typeof vi.fn>;
  activateTab: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  back: ReturnType<typeof vi.fn>;
  forward: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  setPanelBounds: ReturnType<typeof vi.fn>;
  openDevTools: ReturnType<typeof vi.fn>;
  onTabEvent: ReturnType<typeof vi.fn>;
};

let browserApi: BrowserApiMock;

function makeBrowserApiMock(): BrowserApiMock {
  return {
    createTab: vi.fn().mockResolvedValue(undefined),
    destroyTab: vi.fn().mockResolvedValue(undefined),
    destroyEnv: vi.fn().mockResolvedValue(undefined),
    activateTab: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    back: vi.fn().mockResolvedValue(undefined),
    forward: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    setPanelBounds: vi.fn().mockResolvedValue(undefined),
    openDevTools: vi.fn().mockResolvedValue(undefined),
    onTabEvent: vi.fn(() => () => {}),
  };
}

beforeEach(() => {
  storageState.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storageState.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageState.set(key, String(value));
      },
      removeItem: (key: string) => {
        storageState.delete(key);
      },
      clear: () => {
        storageState.clear();
      },
    },
  });
  browserApi = makeBrowserApiMock();
  Object.defineProperty(globalThis, "skeinDesktop", {
    configurable: true,
    value: { browser: browserApi },
  });
  if (typeof window !== "undefined") {
    (window as unknown as { skeinDesktop?: unknown }).skeinDesktop = {
      browser: browserApi,
    };
  }
  useBrowserStore.setState({ byEnv: {} });
  const snapshot = makeWorkspaceSnapshot({
    projects: [
      makeProject({
        id: "project-a",
        environments: [makeEnvironment({ id: ENV, projectId: "project-a" })],
      }),
    ],
  });
  useWorkspaceStore.setState({
    snapshot,
  } as Partial<ReturnType<typeof useWorkspaceStore.getState>>);
  selectEnvironment();
});

afterEach(() => {
  vi.clearAllMocks();
  if (typeof window !== "undefined") {
    delete (window as unknown as { skeinDesktop?: unknown }).skeinDesktop;
  }
});

describe("BrowserPanel", () => {
  it("auto-creates a tab when opened empty", () => {
    render(<BrowserPanel />);
    expect(slot().tabs.length).toBe(1);
  });

  it("does not auto-create a tab when collapsed", () => {
    render(<BrowserPanel collapsed />);
    expect(slot().tabs.length).toBe(0);
  });

  it("does not re-seed after the user closes every tab", () => {
    render(<BrowserPanel />);
    const firstTabId = slot().tabs[0]?.id;
    expect(firstTabId).toBeDefined();
    act(() => {
      useBrowserStore.getState().closeTab(ENV, firstTabId!);
    });
    expect(slot().tabs.length).toBe(0);
  });

  it("renders back/forward/reload buttons with correct disabled state", () => {
    render(<BrowserPanel />);
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload" })).toBeEnabled();
  });

  it("navigating via URL bar pushes history to the active tab and calls IPC", () => {
    render(<BrowserPanel />);
    const input = screen.getByRole("combobox", {
      name: "Address",
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "localhost:5173" } });
    const form = input.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    const tab = slot().tabs[0];
    expect(tab.history[tab.cursor]).toBe("http://localhost:5173/");
    expect(browserApi.navigate).toHaveBeenCalledWith(
      tab.id,
      "http://localhost:5173/",
    );
  });

  it("back becomes enabled after navigating once", () => {
    render(<BrowserPanel />);
    act(() => {
      useBrowserStore.getState().navigate(ENV, "http://localhost:5173");
    });
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
  });

  it("renders one BrowserWebView per tab", () => {
    const { container } = render(<BrowserPanel />);
    act(() => {
      useBrowserStore.getState().openTab(ENV, "http://a");
      useBrowserStore.getState().openTab(ENV, "http://b");
    });
    const views = container.querySelectorAll(
      "[data-testid='browser-webview']",
    );
    expect(views.length).toBe(3);
  });

  it("creates a tab on the main side when a new tab appears", async () => {
    render(<BrowserPanel />);
    await Promise.resolve();
    expect(browserApi.createTab).toHaveBeenCalledTimes(1);
    const tab = slot().tabs[0];
    expect(browserApi.createTab).toHaveBeenCalledWith({
      tabId: tab.id,
      envId: ENV,
      initialUrl: "about:blank",
    });
  });

  it("auto-navigates a pristine blank tab to the most recent detected URL", () => {
    act(() => {
      useBrowserStore
        .getState()
        .reportDetectedUrl(ENV, "http://localhost:5173");
    });
    render(<BrowserPanel />);
    const tab = slot().tabs[0];
    expect(tab.history[tab.cursor]).toBe("http://localhost:5173");
  });

  it("does not hijack a tab that has already been navigated", () => {
    render(<BrowserPanel />);
    act(() => {
      useBrowserStore.getState().navigate(ENV, "http://localhost:3000");
    });
    act(() => {
      useBrowserStore
        .getState()
        .reportDetectedUrl(ENV, "http://localhost:5173");
    });
    const tab = slot().tabs[0];
    expect(tab.history[tab.cursor]).toBe("http://localhost:3000");
  });

  it("new tab opened after a URL was detected lands on that URL", () => {
    act(() => {
      useBrowserStore
        .getState()
        .reportDetectedUrl(ENV, "http://localhost:5173");
    });
    render(<BrowserPanel />);
    act(() => {
      useBrowserStore.getState().openTab(ENV);
    });
    const tabs = slot().tabs;
    const newTab = tabs[tabs.length - 1];
    expect(newTab.history[0]).toBe("http://localhost:5173");
  });

  it("surfaces detectedUrls as datalist options", () => {
    act(() => {
      useBrowserStore
        .getState()
        .reportDetectedUrl(ENV, "http://localhost:5173");
      useBrowserStore
        .getState()
        .reportDetectedUrl(ENV, "http://localhost:3000");
    });
    const { container } = render(<BrowserPanel />);
    const options = container.querySelectorAll("datalist option");
    const values = Array.from(options).map((o) => o.getAttribute("value"));
    expect(values).toEqual([
      "http://localhost:3000",
      "http://localhost:5173",
    ]);
  });

  it("clicking DevTools invokes openDevTools IPC for the active tab", () => {
    render(<BrowserPanel />);
    const tab = slot().tabs[0];
    const button = screen.getByRole("button", { name: "Open DevTools" });
    fireEvent.click(button);
    expect(browserApi.openDevTools).toHaveBeenCalledWith(tab.id);
  });
});
