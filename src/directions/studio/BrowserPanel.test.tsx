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

const storageState = new Map<string, string>();

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

  it("navigating via URL bar pushes history to the active tab", () => {
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
  });

  it("back becomes enabled after navigating once", () => {
    render(<BrowserPanel />);
    act(() => {
      useBrowserStore.getState().navigate(ENV, "http://localhost:5173");
    });
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
  });

  it("rendering more tabs keeps inactive iframes hidden", () => {
    const { container } = render(<BrowserPanel />);
    act(() => {
      useBrowserStore.getState().openTab(ENV, "http://a");
      useBrowserStore.getState().openTab(ENV, "http://b");
    });
    const frames = container.querySelectorAll("[data-testid='browser-frame']");
    expect(frames.length).toBe(3);
    const hidden = container.querySelectorAll(".browser-frame--hidden");
    expect(hidden.length).toBe(2);
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
});
