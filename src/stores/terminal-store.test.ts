import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import {
  MAX_TABS,
  selectTerminalSlot,
  useTerminalStore,
} from "./terminal-store";

vi.mock("../lib/bridge", () => ({
  spawnTerminal: vi.fn(),
  killTerminal: vi.fn().mockResolvedValue(undefined),
}));

const mockedBridge = vi.mocked(bridge);

const storageState = new Map<string, string>();

const ENV_A = "env-a";
const ENV_B = "env-b";

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
    byEnv: {},
  });
  let counter = 0;
  mockedBridge.spawnTerminal.mockImplementation(async ({ environmentId }) => {
    counter += 1;
    return { ptyId: `pty-${counter}`, cwd: `/path/to/${environmentId}` };
  });
});

function slotForA() {
  return selectTerminalSlot(ENV_A)(useTerminalStore.getState());
}

function slotForB() {
  return selectTerminalSlot(ENV_B)(useTerminalStore.getState());
}

describe("terminal-store", () => {
  it("opens a tab in the given environment and sets it active", async () => {
    const id = await useTerminalStore.getState().openTab(ENV_A);
    expect(id).not.toBeNull();
    const slot = slotForA();
    expect(slot.tabs).toHaveLength(1);
    expect(slot.tabs[0]?.title).toBe(ENV_A);
    expect(slot.tabs[0]?.ptyId).toBe("pty-1");
    expect(slot.tabs[0]?.cwd).toBe(`/path/to/${ENV_A}`);
    expect(slot.activeTabId).toBe(id);
    expect(mockedBridge.spawnTerminal).toHaveBeenCalledWith({
      environmentId: ENV_A,
      cols: 80,
      rows: 24,
    });
  });

  it("keeps tabs from different environments isolated", async () => {
    await useTerminalStore.getState().openTab(ENV_A);
    await useTerminalStore.getState().openTab(ENV_A);
    await useTerminalStore.getState().openTab(ENV_B);

    expect(slotForA().tabs).toHaveLength(2);
    expect(slotForB().tabs).toHaveLength(1);
  });

  it("refuses to open beyond MAX_TABS per environment", async () => {
    for (let i = 0; i < MAX_TABS; i++) {
      await useTerminalStore.getState().openTab(ENV_A);
    }
    const overflow = await useTerminalStore.getState().openTab(ENV_A);
    expect(overflow).toBeNull();
    expect(slotForA().tabs).toHaveLength(MAX_TABS);
    expect(mockedBridge.spawnTerminal).toHaveBeenCalledTimes(MAX_TABS);
  });

  it("MAX_TABS cap is per-env, not global", async () => {
    for (let i = 0; i < MAX_TABS; i++) {
      await useTerminalStore.getState().openTab(ENV_A);
    }
    // Env B is fresh — should still be able to open.
    const id = await useTerminalStore.getState().openTab(ENV_B);
    expect(id).not.toBeNull();
    expect(slotForB().tabs).toHaveLength(1);
  });

  it("closeTab removes a tab from its env and re-elects the active one", async () => {
    const a = await useTerminalStore.getState().openTab(ENV_A);
    const b = await useTerminalStore.getState().openTab(ENV_A);
    await useTerminalStore.getState().openTab(ENV_A);
    useTerminalStore.setState({ visible: true });

    expect(slotForA().tabs).toHaveLength(3);

    // Close the active (last) tab — re-elect to remaining last.
    const lastId = slotForA().activeTabId;
    if (!lastId) throw new Error("expected active tab");
    await useTerminalStore.getState().closeTab(ENV_A, lastId);
    expect(slotForA().tabs).toHaveLength(2);
    expect(slotForA().activeTabId).toBe(b);
    expect(useTerminalStore.getState().visible).toBe(true);

    // Close a non-active tab — active stays put.
    if (!a) throw new Error("expected first tab id");
    await useTerminalStore.getState().closeTab(ENV_A, a);
    expect(slotForA().tabs).toHaveLength(1);
    expect(slotForA().activeTabId).toBe(b);

    expect(mockedBridge.killTerminal).toHaveBeenCalledTimes(2);
  });

  it("closing the last tab in an env removes the slot and hides the panel", async () => {
    await useTerminalStore.getState().openTab(ENV_A);
    useTerminalStore.setState({ visible: true });

    const onlyId = slotForA().activeTabId;
    if (!onlyId) throw new Error("expected active tab");

    await useTerminalStore.getState().closeTab(ENV_A, onlyId);

    expect(useTerminalStore.getState().byEnv[ENV_A]).toBeUndefined();
    expect(useTerminalStore.getState().visible).toBe(false);
  });

  it("closing the last tab in env A leaves env B's slot intact", async () => {
    await useTerminalStore.getState().openTab(ENV_A);
    await useTerminalStore.getState().openTab(ENV_B);
    useTerminalStore.setState({ visible: true });

    const tabA = slotForA().activeTabId;
    if (!tabA) throw new Error("expected env A tab");
    await useTerminalStore.getState().closeTab(ENV_A, tabA);

    expect(useTerminalStore.getState().byEnv[ENV_A]).toBeUndefined();
    expect(slotForB().tabs).toHaveLength(1);
  });

  it("activateTab updates only the targeted env", async () => {
    const a1 = await useTerminalStore.getState().openTab(ENV_A);
    await useTerminalStore.getState().openTab(ENV_A);
    if (!a1) throw new Error("expected first tab id");

    useTerminalStore.getState().activateTab(ENV_A, a1);
    expect(slotForA().activeTabId).toBe(a1);
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

  it("markExited flags the matching tab across all envs", async () => {
    await useTerminalStore.getState().openTab(ENV_A);
    await useTerminalStore.getState().openTab(ENV_B);
    const ptyB = slotForB().tabs[0]?.ptyId;
    if (!ptyB) throw new Error("expected ptyId");

    useTerminalStore.getState().markExited(ptyB);

    expect(slotForA().tabs[0]?.exited).toBe(false);
    expect(slotForB().tabs[0]?.exited).toBe(true);
  });

  it("selectTerminalSlot returns an empty slot when env is null or unknown", () => {
    expect(selectTerminalSlot(null)(useTerminalStore.getState()).tabs).toEqual(
      [],
    );
    expect(
      selectTerminalSlot("nope")(useTerminalStore.getState()).tabs,
    ).toEqual([]);
  });
});
