import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import { TERMINAL_LAYOUTS_STORAGE_KEY } from "../lib/app-identity";
import * as terminalOutputBus from "../lib/terminal-output-bus";
import {
  MAX_TABS,
  selectTerminalSlot,
  useTerminalStore,
} from "./terminal-store";

vi.mock("../lib/bridge", () => ({
  spawnTerminal: vi.fn(),
  runProjectAction: vi.fn(),
  killTerminal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/terminal-output-bus", () => ({
  ensureTerminalOutputBusReady: vi.fn().mockResolvedValue(undefined),
  dropPendingTerminalOutput: vi.fn(),
  subscribeToTerminalOutput: vi.fn(() => () => {}),
  __resetTerminalOutputBus: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);
const mockedTerminalOutputBus = vi.mocked(terminalOutputBus);

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
    byEnv: {},
    knownEnvironmentIds: [ENV_A, ENV_B],
  });
  let counter = 0;
  mockedBridge.spawnTerminal.mockImplementation(async ({ environmentId }) => {
    counter += 1;
    return { ptyId: `pty-${counter}`, cwd: `/path/to/${environmentId}` };
  });
  mockedBridge.runProjectAction.mockImplementation(async ({ environmentId, actionId }) => {
    counter += 1;
    const actionLabel = actionId === "dev" ? "Dev" : `Action ${actionId}`;
    return {
      ptyId: `pty-${counter}`,
      cwd: `/path/to/${environmentId}`,
      actionId,
      actionLabel,
      actionIcon: "play",
    };
  });
});

function slotForA() {
  return selectTerminalSlot(ENV_A)(useTerminalStore.getState());
}

function slotForB() {
  return selectTerminalSlot(ENV_B)(useTerminalStore.getState());
}

function readPersistedLayouts() {
  const raw = localStorage.getItem(TERMINAL_LAYOUTS_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, { visible: boolean; height: number }>) : {};
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
    expect(slot.tabs[0]?.kind).toBe("shell");
    expect(slot.activeTabId).toBe(id);
    expect(mockedBridge.spawnTerminal).toHaveBeenCalledWith({
      environmentId: ENV_A,
      cols: 80,
      rows: 24,
    });
  });

  it("uses the default height when no persisted value exists", async () => {
    vi.resetModules();
    const {
      selectTerminalSlot: freshSelectTerminalSlot,
      useTerminalStore: freshStore,
    } = await import("./terminal-store");

    expect(freshSelectTerminalSlot(ENV_A)(freshStore.getState()).height).toBe(280);
  });

  it("uses the legacy terminal height as the default env height without propagating visibility", async () => {
    storageState.set("loom-terminal-height", "360");
    storageState.set("loom-terminal-visible", "1");
    storageState.set("threadex-terminal-height", "240");
    storageState.set("threadex-terminal-visible", "0");

    vi.resetModules();
    const {
      selectTerminalSlot: freshSelectTerminalSlot,
      useTerminalStore: freshStore,
    } = await import("./terminal-store");

    expect(freshSelectTerminalSlot(ENV_A)(freshStore.getState()).height).toBe(360);
    expect(freshSelectTerminalSlot(ENV_A)(freshStore.getState()).visible).toBe(false);
    expect(localStorage.getItem("skein-terminal-height")).toBe("360");
    expect(localStorage.getItem("skein-terminal-visible")).toBeNull();
    expect(localStorage.getItem("loom-terminal-height")).toBeNull();
    expect(localStorage.getItem("threadex-terminal-height")).toBeNull();
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

  it("derives titles from Windows-style cwd paths", async () => {
    mockedBridge.spawnTerminal.mockResolvedValueOnce({
      ptyId: "pty-win",
      cwd: "C:\\Users\\paul\\repo",
    });

    await useTerminalStore.getState().openTab(ENV_A);

    expect(slotForA().tabs[0]?.title).toBe("repo");
  });

  it("closeTab removes a tab from its env and re-elects the active one", async () => {
    const a = await useTerminalStore.getState().openTab(ENV_A);
    const b = await useTerminalStore.getState().openTab(ENV_A);
    await useTerminalStore.getState().openTab(ENV_A);

    expect(slotForA().tabs).toHaveLength(3);

    // Close the active (last) tab — re-elect to remaining last.
    const lastId = slotForA().activeTabId;
    if (!lastId) throw new Error("expected active tab");
    await useTerminalStore.getState().closeTab(ENV_A, lastId);
    expect(slotForA().tabs).toHaveLength(2);
    expect(slotForA().activeTabId).toBe(b);
    expect(slotForA().visible).toBe(true);

    // Close a non-active tab — active stays put.
    if (!a) throw new Error("expected first tab id");
    await useTerminalStore.getState().closeTab(ENV_A, a);
    expect(slotForA().tabs).toHaveLength(1);
    expect(slotForA().activeTabId).toBe(b);

    expect(mockedBridge.killTerminal).toHaveBeenCalledTimes(2);
  });

  it("closing the last tab in an env keeps the slot but hides that panel", async () => {
    await useTerminalStore.getState().openTab(ENV_A);

    const onlyId = slotForA().activeTabId;
    if (!onlyId) throw new Error("expected active tab");

    await useTerminalStore.getState().closeTab(ENV_A, onlyId);

    expect(slotForA().tabs).toEqual([]);
    expect(slotForA().visible).toBe(false);
  });

  it("closing the last tab in env A leaves env B's slot intact", async () => {
    await useTerminalStore.getState().openTab(ENV_A);
    await useTerminalStore.getState().openTab(ENV_B);

    const tabA = slotForA().activeTabId;
    if (!tabA) throw new Error("expected env A tab");
    await useTerminalStore.getState().closeTab(ENV_A, tabA);

    expect(slotForA().tabs).toEqual([]);
    expect(slotForA().visible).toBe(false);
    expect(slotForB().tabs).toHaveLength(1);
    expect(slotForB().visible).toBe(true);
  });

  it("activateTab updates only the targeted env", async () => {
    const a1 = await useTerminalStore.getState().openTab(ENV_A);
    await useTerminalStore.getState().openTab(ENV_A);
    if (!a1) throw new Error("expected first tab id");

    useTerminalStore.getState().activateTab(ENV_A, a1);
    expect(slotForA().activeTabId).toBe(a1);
  });

  it("activateTab preserves the current tab state for the environment", async () => {
    const actionTabId = await useTerminalStore.getState().openActionTab(ENV_A, {
      id: "dev",
      label: "Dev",
      icon: "play",
    });
    if (!actionTabId) {
      throw new Error("expected action tab id");
    }

    useTerminalStore.getState().markExited("pty-1");
    useTerminalStore.getState().activateTab(ENV_A, actionTabId);

    expect(slotForA().tabs[0]?.exited).toBe(true);
    expect(slotForA().activeTabId).toBe(actionTabId);
  });

  it("setHeight clamps below MIN_HEIGHT and above 0.8 * window.innerHeight", () => {
    useTerminalStore.getState().setHeight(ENV_A, 40);
    expect(slotForA().height).toBe(120);

    useTerminalStore.getState().setHeight(ENV_A, 99999);
    // 0.8 * 1000 = 800
    expect(slotForA().height).toBe(800);

    useTerminalStore.getState().setHeight(ENV_A, 300);
    expect(slotForA().height).toBe(300);
    expect(readPersistedLayouts()[ENV_A]).toMatchObject({ height: 300 });
  });

  it("toggleVisible flips visibility per environment and persists to localStorage", () => {
    expect(slotForA().visible).toBe(false);
    useTerminalStore.getState().toggleVisible(ENV_A);
    expect(slotForA().visible).toBe(true);
    expect(readPersistedLayouts()[ENV_A]).toMatchObject({ visible: true });
    useTerminalStore.getState().toggleVisible(ENV_A);
    expect(slotForA().visible).toBe(false);
    expect(readPersistedLayouts()[ENV_A]).toMatchObject({ visible: false });
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

  it("opens a manual action tab and makes it active", async () => {
    const id = await useTerminalStore.getState().openActionTab(ENV_A, {
      id: "dev",
      label: "Dev",
      icon: "play",
    });

    expect(id).not.toBeNull();
    const slot = slotForA();
    expect(slot.tabs).toHaveLength(1);
    expect(slot.tabs[0]).toMatchObject({
      id,
      ptyId: "pty-1",
      cwd: `/path/to/${ENV_A}`,
      title: "Dev",
      kind: "manualAction",
      actionId: "dev",
      actionLabel: "Dev",
      actionIcon: "play",
      exited: false,
    });
    expect(slot.activeTabId).toBe(id);
    expect(mockedBridge.runProjectAction).toHaveBeenCalledWith({
      environmentId: ENV_A,
      actionId: "dev",
    });
  });

  it("focuses an existing running manual action instead of relaunching it", async () => {
    const first = await useTerminalStore.getState().openActionTab(ENV_A, {
      id: "dev",
      label: "Dev",
      icon: "play",
    });
    if (!first) {
      throw new Error("expected first action tab");
    }

    const second = await useTerminalStore.getState().openActionTab(ENV_A, {
      id: "dev",
      label: "Dev",
      icon: "play",
    });

    expect(second).toBe(first);
    expect(slotForA().tabs).toHaveLength(1);
    expect(mockedBridge.runProjectAction).toHaveBeenCalledTimes(1);
  });

  it("reuses the same action tab id after the previous run exited", async () => {
    const first = await useTerminalStore.getState().openActionTab(ENV_A, {
      id: "dev",
      label: "Dev",
      icon: "play",
    });
    if (!first) {
      throw new Error("expected first action tab");
    }
    useTerminalStore.getState().markExited("pty-1");

    const second = await useTerminalStore.getState().openActionTab(ENV_A, {
      id: "dev",
      label: "Dev",
      icon: "play",
    });

    expect(second).toBe(first);
    expect(slotForA().tabs).toHaveLength(1);
    expect(slotForA().tabs[0]?.ptyId).toBe("pty-2");
    expect(slotForA().tabs[0]?.exited).toBe(false);
    expect(mockedBridge.runProjectAction).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent launches of the same manual action", async () => {
    let resolveRun: (
      value: Awaited<ReturnType<typeof bridge.runProjectAction>>,
    ) => void = () => {};
    const pendingRun = new Promise<Awaited<ReturnType<typeof bridge.runProjectAction>>>(
      (resolve) => {
        resolveRun = resolve;
      },
    );
    mockedBridge.runProjectAction.mockImplementationOnce(() => pendingRun);

    const firstOpen = useTerminalStore.getState().openActionTab(ENV_A, {
      id: "dev",
      label: "Dev",
      icon: "play",
    });
    const secondOpen = useTerminalStore.getState().openActionTab(ENV_A, {
      id: "dev",
      label: "Dev",
      icon: "play",
    });

    resolveRun({
      ptyId: "pty-pending",
      cwd: `/path/to/${ENV_A}`,
      actionId: "dev",
      actionLabel: "Dev",
      actionIcon: "play",
    });

    const [firstId, secondId] = await Promise.all([firstOpen, secondOpen]);

    expect(firstId).toBe(secondId);
    expect(slotForA().tabs).toHaveLength(1);
    expect(slotForA().tabs[0]?.ptyId).toBe("pty-pending");
    expect(mockedBridge.runProjectAction).toHaveBeenCalledTimes(1);
  });

  it("rechecks the tab cap when a reusable action tab disappears mid-launch", async () => {
    const reusableId = await useTerminalStore.getState().openActionTab(ENV_A, {
      id: "dev",
      label: "Dev",
      icon: "play",
    });
    if (!reusableId) {
      throw new Error("expected reusable action tab");
    }
    useTerminalStore.getState().markExited("pty-1");

    for (let i = 0; i < MAX_TABS - 1; i += 1) {
      await useTerminalStore.getState().openTab(ENV_A);
    }

    let resolveRun: (
      value: Awaited<ReturnType<typeof bridge.runProjectAction>>,
    ) => void = () => {};
    const pendingRun = new Promise<Awaited<ReturnType<typeof bridge.runProjectAction>>>(
      (resolve) => {
        resolveRun = resolve;
      },
    );
    mockedBridge.runProjectAction.mockImplementationOnce(() => pendingRun);

    const pendingOpen = useTerminalStore.getState().openActionTab(ENV_A, {
      id: "dev",
      label: "Dev",
      icon: "play",
    });

    await useTerminalStore.getState().closeTab(ENV_A, reusableId);
    await useTerminalStore.getState().openTab(ENV_A);

    resolveRun({
      ptyId: "pty-overflow",
      cwd: `/path/to/${ENV_A}`,
      actionId: "dev",
      actionLabel: "Dev",
      actionIcon: "play",
    });

    await expect(pendingOpen).resolves.toBeNull();
    expect(slotForA().tabs).toHaveLength(MAX_TABS);
    expect(slotForA().tabs.some((tab) => tab.ptyId === "pty-overflow")).toBe(false);
    expect(mockedBridge.killTerminal).toHaveBeenCalledWith({
      ptyId: "pty-overflow",
    });
    expect(mockedTerminalOutputBus.dropPendingTerminalOutput).toHaveBeenCalledWith(
      "pty-overflow",
    );
  });

  it("preserves manual action titles when workspace metadata updates", async () => {
    await useTerminalStore.getState().openActionTab(ENV_A, {
      id: "dev",
      label: "Dev",
      icon: "play",
    });

    useTerminalStore.getState().syncWorkspaceSnapshot({
      settings: {
        shortcuts: {},
        openTargets: [],
        defaultOpenTargetId: "file-manager",
        defaultModel: "gpt-5.4",
        defaultReasoningEffort: "high",
        defaultCollaborationMode: "build",
        defaultApprovalPolicy: "askToEdit",
        streamAssistantResponses: true,
        collapseWorkActivity: true,
        desktopNotificationsEnabled: false,
        multiAgentNudgeEnabled: false,
        multiAgentNudgeMaxSubagents: 4,
        notificationSounds: {
          attention: { enabled: true, sound: "glass" },
          completion: { enabled: true, sound: "glass" },
        },
      },
      projects: [
        {
          id: "project-1",
          name: "Skein",
          rootPath: "/tmp/skein",
          settings: {},
          sidebarCollapsed: false,
          createdAt: "2026-04-03T08:00:00Z",
          updatedAt: "2026-04-03T08:00:00Z",
          environments: [
            {
              id: ENV_A,
              projectId: "project-1",
              name: "Local",
              kind: "local",
              path: "/path/to/renamed-env",
              isDefault: true,
              createdAt: "2026-04-03T08:00:00Z",
              updatedAt: "2026-04-03T08:00:00Z",
              threads: [],
              runtime: { environmentId: ENV_A, state: "running" },
            },
          ],
        },
      ],
    });

    expect(slotForA().tabs[0]?.title).toBe("Dev");
    expect(slotForA().tabs[0]?.cwd).toBe("/path/to/renamed-env");
  });

  it("reconcileEnvironments prunes deleted environments and hides the panel when empty", async () => {
    await useTerminalStore.getState().openTab(ENV_A);
    await useTerminalStore.getState().openTab(ENV_B);

    useTerminalStore.getState().reconcileEnvironments([ENV_B]);

    expect(useTerminalStore.getState().byEnv[ENV_A]).toBeUndefined();
    expect(useTerminalStore.getState().byEnv[ENV_B]?.tabs).toHaveLength(1);
    expect(slotForB().visible).toBe(true);

    useTerminalStore.getState().reconcileEnvironments([]);

    expect(useTerminalStore.getState().byEnv).toEqual({});
  });

  it("kills PTYs for pruned environments during reconciliation", async () => {
    await useTerminalStore.getState().openTab(ENV_A);
    await useTerminalStore.getState().openTab(ENV_B);

    useTerminalStore.getState().reconcileEnvironments([ENV_B]);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedBridge.killTerminal).toHaveBeenCalledWith({
      ptyId: "pty-1",
    });
    expect(mockedTerminalOutputBus.dropPendingTerminalOutput).toHaveBeenCalledWith(
      "pty-1",
    );
    expect(useTerminalStore.getState().byEnv[ENV_A]).toBeUndefined();
  });

  it("restores persisted per-environment panel state when environments are reconciled", async () => {
    localStorage.setItem(
      "skein-terminal-layouts",
      JSON.stringify({
        [ENV_A]: {
          visible: true,
          height: 320,
        },
      }),
    );
    vi.resetModules();

    const {
      selectTerminalSlot: freshSelectTerminalSlot,
      useTerminalStore: freshStore,
    } = await import("./terminal-store");
    freshStore.setState({
      byEnv: {},
      knownEnvironmentIds: [],
    });
    freshStore.getState().reconcileEnvironments([ENV_A]);

    expect(freshSelectTerminalSlot(ENV_A)(freshStore.getState())).toMatchObject({
      visible: true,
      height: 320,
    });
  });

  it("kills the PTY if the environment disappears while openTab is in flight", async () => {
    let resolveSpawn: (value: { ptyId: string; cwd: string }) => void = () => {};
    const pendingSpawn = new Promise<{ ptyId: string; cwd: string }>((resolve) => {
      resolveSpawn = resolve;
    });
    mockedBridge.spawnTerminal.mockImplementationOnce(() => pendingSpawn);
    useTerminalStore.getState().reconcileEnvironments([ENV_A]);

    const openPromise = useTerminalStore.getState().openTab(ENV_A);
    useTerminalStore.getState().reconcileEnvironments([ENV_B]);
    resolveSpawn({ ptyId: "pty-pending", cwd: `/path/to/${ENV_A}` });

    await expect(openPromise).resolves.toBeNull();
    expect(mockedBridge.killTerminal).toHaveBeenCalledWith({
      ptyId: "pty-pending",
    });
    expect(useTerminalStore.getState().byEnv[ENV_A]).toBeUndefined();
  });

  it("kills the PTY if all environments disappear while openTab is in flight", async () => {
    let resolveSpawn: (value: { ptyId: string; cwd: string }) => void = () => {};
    const pendingSpawn = new Promise<{ ptyId: string; cwd: string }>((resolve) => {
      resolveSpawn = resolve;
    });
    mockedBridge.spawnTerminal.mockImplementationOnce(() => pendingSpawn);
    useTerminalStore.getState().reconcileEnvironments([ENV_A]);

    const openPromise = useTerminalStore.getState().openTab(ENV_A);
    useTerminalStore.getState().reconcileEnvironments([]);
    resolveSpawn({ ptyId: "pty-empty", cwd: `/path/to/${ENV_A}` });

    await expect(openPromise).resolves.toBeNull();
    expect(mockedBridge.killTerminal).toHaveBeenCalledWith({
      ptyId: "pty-empty",
    });
    expect(useTerminalStore.getState().byEnv[ENV_A]).toBeUndefined();
  });

  it("kills the PTY if all environments disappear while an action tab is launching", async () => {
    let resolveRun: (
      value: Awaited<ReturnType<typeof bridge.runProjectAction>>,
    ) => void = () => {};
    const pendingRun = new Promise<Awaited<ReturnType<typeof bridge.runProjectAction>>>(
      (resolve) => {
        resolveRun = resolve;
      },
    );
    mockedBridge.runProjectAction.mockImplementationOnce(() => pendingRun);
    useTerminalStore.getState().reconcileEnvironments([ENV_A]);

    const openPromise = useTerminalStore.getState().openActionTab(ENV_A, {
      id: "dev",
      label: "Dev",
      icon: "play",
    });
    useTerminalStore.getState().reconcileEnvironments([]);
    resolveRun({
      ptyId: "pty-action-empty",
      cwd: `/path/to/${ENV_A}`,
      actionId: "dev",
      actionLabel: "Dev",
      actionIcon: "play",
    });

    await expect(openPromise).resolves.toBeNull();
    expect(mockedBridge.killTerminal).toHaveBeenCalledWith({
      ptyId: "pty-action-empty",
    });
    expect(useTerminalStore.getState().byEnv[ENV_A]).toBeUndefined();
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
