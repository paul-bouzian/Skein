import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import { MAX_TABS, useTerminalStore } from "./terminal-store";

vi.mock("../lib/bridge", () => ({
  spawnTerminal: vi.fn(),
  killTerminal: vi.fn().mockResolvedValue(undefined),
}));

const mockedBridge = vi.mocked(bridge);

const storageState = new Map<string, string>();

beforeEach(() => {
  vi.clearAllMocks();
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
  Object.defineProperty(window, "innerHeight", {
    value: 1000,
    configurable: true,
  });
  useTerminalStore.setState({
    visible: false,
    height: 280,
    tabs: [],
    activeTabId: null,
  });
  let counter = 0;
  mockedBridge.spawnTerminal.mockImplementation(async () => {
    counter += 1;
    return { ptyId: `pty-${counter}` };
  });
});

describe("terminal-store", () => {
  it("opens a tab and sets it active", async () => {
    const id = await useTerminalStore.getState().openTab("/Users/foo/repo");
    expect(id).not.toBeNull();
    const state = useTerminalStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.title).toBe("repo");
    expect(state.tabs[0]?.ptyId).toBe("pty-1");
    expect(state.activeTabId).toBe(id);
    expect(mockedBridge.spawnTerminal).toHaveBeenCalledWith({
      cwd: "/Users/foo/repo",
      cols: 80,
      rows: 24,
    });
  });

  it("refuses to open beyond MAX_TABS", async () => {
    for (let i = 0; i < MAX_TABS; i++) {
      await useTerminalStore.getState().openTab(`/p/${i}`);
    }
    const overflow = await useTerminalStore.getState().openTab("/p/overflow");
    expect(overflow).toBeNull();
    expect(useTerminalStore.getState().tabs).toHaveLength(MAX_TABS);
    expect(mockedBridge.spawnTerminal).toHaveBeenCalledTimes(MAX_TABS);
  });

  it("closeTab removes a tab and re-elects the active one", async () => {
    const a = await useTerminalStore.getState().openTab("/p/a");
    const b = await useTerminalStore.getState().openTab("/p/b");
    await useTerminalStore.getState().openTab("/p/c");
    useTerminalStore.setState({ visible: true });

    expect(useTerminalStore.getState().tabs).toHaveLength(3);

    // Close the active (last) tab — re-elect to remaining last.
    const lastId = useTerminalStore.getState().activeTabId;
    if (!lastId) throw new Error("expected active tab");
    await useTerminalStore.getState().closeTab(lastId);
    expect(useTerminalStore.getState().tabs).toHaveLength(2);
    expect(useTerminalStore.getState().activeTabId).toBe(b);
    expect(useTerminalStore.getState().visible).toBe(true);

    // Close a non-active tab — active stays put.
    if (!a) throw new Error("expected first tab id");
    await useTerminalStore.getState().closeTab(a);
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
    expect(useTerminalStore.getState().activeTabId).toBe(b);

    expect(mockedBridge.killTerminal).toHaveBeenCalledTimes(2);
  });

  it("closing the last tab hides the panel", async () => {
    await useTerminalStore.getState().openTab("/p/only");
    useTerminalStore.setState({ visible: true });

    const onlyId = useTerminalStore.getState().activeTabId;
    if (!onlyId) throw new Error("expected active tab");

    await useTerminalStore.getState().closeTab(onlyId);

    expect(useTerminalStore.getState().tabs).toHaveLength(0);
    expect(useTerminalStore.getState().activeTabId).toBeNull();
    expect(useTerminalStore.getState().visible).toBe(false);
  });

  it("setHeight clamps below MIN_HEIGHT and above 0.8 * window.innerHeight", () => {
    useTerminalStore.getState().setHeight(40);
    expect(useTerminalStore.getState().height).toBe(120);

    useTerminalStore.getState().setHeight(99999);
    // 0.8 * 1000 = 800
    expect(useTerminalStore.getState().height).toBe(800);

    useTerminalStore.getState().setHeight(300);
    expect(useTerminalStore.getState().height).toBe(300);
    expect(localStorage.getItem("threadex-terminal-height")).toBe("300");
  });

  it("toggleVisible flips visibility and persists to localStorage", () => {
    expect(useTerminalStore.getState().visible).toBe(false);
    useTerminalStore.getState().toggleVisible();
    expect(useTerminalStore.getState().visible).toBe(true);
    expect(localStorage.getItem("threadex-terminal-visible")).toBe("1");
    useTerminalStore.getState().toggleVisible();
    expect(useTerminalStore.getState().visible).toBe(false);
    expect(localStorage.getItem("threadex-terminal-visible")).toBe("0");
  });

  it("markExited flags the matching tab", async () => {
    await useTerminalStore.getState().openTab("/p/a");
    const ptyId = useTerminalStore.getState().tabs[0]?.ptyId;
    if (!ptyId) throw new Error("expected ptyId");
    useTerminalStore.getState().markExited(ptyId);
    expect(useTerminalStore.getState().tabs[0]?.exited).toBe(true);
  });
});
