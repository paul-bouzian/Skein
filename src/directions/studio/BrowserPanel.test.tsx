import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBrowserStore } from "../../stores/browser-store";
import { BrowserPanel } from "./BrowserPanel";
import { normalizeBrowserUrl } from "./BrowserUrlBar";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

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
  useBrowserStore.setState({
    tabs: [],
    activeTabId: null,
    detectedUrls: [],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("normalizeBrowserUrl", () => {
  it("prefixes http:// to bare localhost", () => {
    expect(normalizeBrowserUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeBrowserUrl("127.0.0.1:8000")).toBe(
      "http://127.0.0.1:8000",
    );
  });

  it("keeps explicit protocol", () => {
    expect(normalizeBrowserUrl("https://github.com")).toBe(
      "https://github.com",
    );
  });

  it("rejects a bare word (no dot, no colon)", () => {
    expect(normalizeBrowserUrl("hello")).toBeNull();
  });

  it("prefixes https:// for domains", () => {
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com");
  });

  it("returns null for empty input", () => {
    expect(normalizeBrowserUrl("   ")).toBeNull();
  });
});

describe("BrowserPanel", () => {
  it("auto-creates a tab when opened empty", () => {
    render(<BrowserPanel />);
    expect(useBrowserStore.getState().tabs.length).toBe(1);
  });

  it("does not auto-create a tab when collapsed", () => {
    render(<BrowserPanel collapsed />);
    expect(useBrowserStore.getState().tabs.length).toBe(0);
  });

  it("renders back/forward/reload buttons with correct disabled state", () => {
    render(<BrowserPanel />);
    expect(
      screen.getByRole("button", { name: "Back" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Forward" }),
    ).toBeDisabled();
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
    const tab = useBrowserStore.getState().tabs[0];
    expect(tab.history[tab.cursor]).toBe("http://localhost:5173");
  });

  it("back becomes enabled after navigating once", () => {
    render(<BrowserPanel />);
    act(() => {
      useBrowserStore.getState().navigate("http://localhost:5173");
    });
    expect(
      screen.getByRole("button", { name: "Back" }),
    ).toBeEnabled();
  });

  it("rendering more tabs keeps inactive iframes hidden", () => {
    const { container } = render(<BrowserPanel />);
    act(() => {
      useBrowserStore.getState().openTab("http://a");
      useBrowserStore.getState().openTab("http://b");
    });
    const frames = container.querySelectorAll("[data-testid='browser-frame']");
    // 1 auto + 2 manually added = 3 frames, all kept alive.
    expect(frames.length).toBe(3);
    const hidden = container.querySelectorAll(".browser-frame--hidden");
    // Only the active frame is non-hidden, so N-1 hidden.
    expect(hidden.length).toBe(2);
  });

  it("surfaces detectedUrls as datalist options", () => {
    act(() => {
      useBrowserStore.getState().reportDetectedUrl("http://localhost:5173");
      useBrowserStore.getState().reportDetectedUrl("http://localhost:3000");
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
