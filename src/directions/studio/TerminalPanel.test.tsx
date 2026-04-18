import { StrictMode, act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import {
  __resetTerminalEventSubscriptions,
  selectTerminalSlot,
  useTerminalStore,
  type EnvironmentTerminalSlot,
} from "../../stores/terminal-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import {
  makeEnvironment,
  makeThread,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { TerminalPanel } from "./TerminalPanel";

vi.mock("./TerminalView", () => ({
  TerminalView: ({ ptyId, active }: { ptyId: string; active: boolean }) => (
    <div data-testid={`terminal-view-${ptyId}`} data-active={active} />
  ),
}));

vi.mock("../../lib/bridge", () => ({
  spawnTerminal: vi.fn(),
  runProjectAction: vi.fn(),
  killTerminal: vi.fn().mockResolvedValue(undefined),
  listenToTerminalExit: vi.fn().mockResolvedValue(() => {}),
  listenToProjectActionState: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/terminal-output-bus", () => ({
  ensureTerminalOutputBusReady: vi.fn().mockResolvedValue(undefined),
  dropPendingTerminalOutput: vi.fn(),
  subscribeToTerminalOutput: vi.fn(() => () => {}),
  __resetTerminalOutputBus: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);

const storageState = new Map<string, string>();

const ENV_ID = "env-1";
const PANEL_THEME = "dark" as const;

function renderPanel() {
  return render(<TerminalPanel theme={PANEL_THEME} />);
}

function makeSlot(
  overrides: Partial<EnvironmentTerminalSlot>,
): EnvironmentTerminalSlot {
  return {
    tabs: [],
    activeTabId: null,
    visible: false,
    height: 280,
    ...overrides,
  };
}

function readSlot(environmentId: string) {
  return selectTerminalSlot(environmentId)(useTerminalStore.getState());
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetTerminalEventSubscriptions();
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

  let counter = 0;
  mockedBridge.spawnTerminal.mockImplementation(async ({ environmentId }) => {
    counter += 1;
    return { ptyId: `pty-${counter}`, cwd: `/tmp/${environmentId}` };
  });

  // Workspace with one environment selected so the panel has a real env-id.
  useWorkspaceStore.setState({
    snapshot: makeWorkspaceSnapshot(),
    bootstrapStatus: null,
    loadingState: "ready",
    error: null,
    layout: {
      slots: {
        topLeft: null,
        topRight: null,
        bottomLeft: null,
        bottomRight: null,
      },
      focusedSlot: null,
      rowRatio: 0.5,
      colRatio: 0.5,
    },
    draftBySlot: {},
    selectedProjectId: "project-1",
    selectedEnvironmentId: ENV_ID,
    selectedThreadId: null,
  });

  // Seed terminal store with two tabs in this env to bypass auto-bootstrap.
  useTerminalStore.setState({
    knownEnvironmentIds: [ENV_ID],
    byEnv: {
      [ENV_ID]: makeSlot({
        tabs: [
          {
            id: "t1",
            ptyId: "pty-existing-1",
            cwd: "/p/a",
            title: "a",
            exited: false,
            kind: "shell",
          },
          {
            id: "t2",
            ptyId: "pty-existing-2",
            cwd: "/p/b",
            title: "b",
            exited: false,
            kind: "shell",
          },
        ],
        activeTabId: "t1",
        visible: true,
      }),
    },
  });
});

describe("TerminalPanel", () => {
  it("renders only the active terminal view for the selected environment", () => {
    renderPanel();
    expect(screen.getByTestId("terminal-view-pty-existing-1")).toBeInTheDocument();
    expect(
      screen.queryByTestId("terminal-view-pty-existing-2"),
    ).not.toBeInTheDocument();
  });

  it("switches the mounted terminal view when switching environments", () => {
    const snapshotWithTwoEnvs = makeWorkspaceSnapshot();
    snapshotWithTwoEnvs.projects[0].environments.push({
      ...snapshotWithTwoEnvs.projects[0].environments[0],
      id: "env-2",
      name: "worktree-2",
      path: "/tmp/env-2",
    });
    useWorkspaceStore.setState({
      snapshot: snapshotWithTwoEnvs,
      bootstrapStatus: null,
      loadingState: "ready",
      error: null,
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
      selectedThreadId: null,
    });
    useTerminalStore.setState((state) => ({
      ...state,
      byEnv: {
        ...state.byEnv,
        "env-2": makeSlot({
          tabs: [
            {
              id: "t3",
              ptyId: "pty-existing-3",
              cwd: "/p/c",
              title: "c",
              exited: false,
              kind: "shell",
            },
          ],
          activeTabId: "t3",
          visible: true,
        }),
      },
    }));

    const { rerender } = renderPanel();

    expect(screen.getByTestId("terminal-view-pty-existing-1")).toHaveAttribute("data-active", "true");
    expect(
      screen.queryByTestId("terminal-view-pty-existing-3"),
    ).not.toBeInTheDocument();

    act(() => {
      useWorkspaceStore.setState({ selectedEnvironmentId: "env-2" });
    });
    rerender(<TerminalPanel theme={PANEL_THEME} />);

    expect(
      screen.queryByTestId("terminal-view-pty-existing-1"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("terminal-view-pty-existing-3")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-view-pty-existing-3")).toHaveAttribute("data-active", "true");
  });

  it("does not auto-bootstrap a terminal for chat environments", async () => {
    const chatThread = makeThread({
      id: "chat-thread-1",
      environmentId: "chat-env-1",
    });
    const chatEnvironment = makeEnvironment({
      id: "chat-env-1",
      projectId: "skein-chat-workspace",
      name: "Chat",
      kind: "chat",
      path: "/tmp/.skein/chats/chat-env-1",
      gitBranch: undefined,
      baseBranch: undefined,
      isDefault: false,
      pullRequest: undefined,
      threads: [chatThread],
      runtime: undefined,
    });
    const baseSnapshot = makeWorkspaceSnapshot();
    useWorkspaceStore.setState({
      snapshot: {
        ...baseSnapshot,
        chat: {
          ...baseSnapshot.chat,
          environments: [chatEnvironment],
        },
      },
      bootstrapStatus: null,
      loadingState: "ready",
      error: null,
      selectedProjectId: "skein-chat-workspace",
      selectedEnvironmentId: "chat-env-1",
      selectedThreadId: "chat-thread-1",
    });
    useTerminalStore.setState({
      knownEnvironmentIds: [],
      byEnv: {
        "chat-env-1": makeSlot({
          visible: true,
        }),
      },
    });

    renderPanel();

    await waitFor(() => {
      expect(mockedBridge.spawnTerminal).not.toHaveBeenCalled();
    });
    expect(
      screen.getByText("Select an environment to open a terminal."),
    ).toBeInTheDocument();
  });

  it("opens a new terminal in the active env when + is clicked", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTitle("New terminal"));

    await waitFor(() => {
      expect(mockedBridge.spawnTerminal).toHaveBeenCalledWith({
        environmentId: ENV_ID,
        cols: 80,
        rows: 24,
      });
    });
    expect(useTerminalStore.getState().byEnv[ENV_ID]?.tabs).toHaveLength(3);
  });

  it("closes a tab via the per-tab close button", async () => {
    const user = userEvent.setup();
    renderPanel();

    const closeButtons = screen.getAllByLabelText("Close terminal");
    await user.click(closeButtons[0]);

    await waitFor(() => {
      expect(useTerminalStore.getState().byEnv[ENV_ID]?.tabs).toHaveLength(1);
    });
    expect(mockedBridge.killTerminal).toHaveBeenCalledWith({
      ptyId: "pty-existing-1",
    });
  });

  it("does not auto-bootstrap immediately after closing the last tab when another environment still has one", async () => {
    const user = userEvent.setup();
    const snapshotWithTwoEnvs = makeWorkspaceSnapshot();
    snapshotWithTwoEnvs.projects[0].environments.push({
      ...snapshotWithTwoEnvs.projects[0].environments[0],
      id: "env-2",
      name: "worktree-2",
      path: "/tmp/env-2",
    });
    useWorkspaceStore.setState({
      snapshot: snapshotWithTwoEnvs,
      bootstrapStatus: null,
      loadingState: "ready",
      error: null,
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
      selectedThreadId: null,
    });
    useTerminalStore.setState({
      knownEnvironmentIds: ["env-1", "env-2"],
      byEnv: {
        "env-1": makeSlot({
          tabs: [
            {
              id: "t1",
              ptyId: "pty-existing-1",
              cwd: "/p/a",
              title: "a",
              exited: false,
              kind: "shell",
            },
          ],
          activeTabId: "t1",
          visible: true,
        }),
        "env-2": makeSlot({
          tabs: [
            {
              id: "t2",
              ptyId: "pty-existing-2",
              cwd: "/p/b",
              title: "b",
              exited: false,
              kind: "shell",
            },
          ],
          activeTabId: "t2",
          visible: true,
        }),
      },
    });
    mockedBridge.spawnTerminal.mockClear();

    renderPanel();

    await user.click(screen.getByLabelText("Close terminal"));

    await waitFor(() => {
      expect(readSlot("env-1").tabs).toHaveLength(0);
    });
    expect(readSlot("env-1").visible).toBe(false);
    expect(readSlot("env-2").visible).toBe(true);
    expect(mockedBridge.spawnTerminal).not.toHaveBeenCalled();
    expect(
      screen.getByText("No terminals are open in this environment."),
    ).toBeInTheDocument();
  });

  it("hides the panel when the hide button is clicked", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTitle("Hide terminal"));
    expect(readSlot(ENV_ID).visible).toBe(false);
  });

  it("activates a tab when its title is clicked", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByText("b"));
    expect(useTerminalStore.getState().byEnv[ENV_ID]?.activeTabId).toBe("t2");
  });

  it("renders an empty state when no environment is selected", () => {
    useWorkspaceStore.setState({
      snapshot: null,
      bootstrapStatus: null,
      loadingState: "idle",
      error: null,
      selectedProjectId: null,
      selectedEnvironmentId: null,
      selectedThreadId: null,
    });
    useTerminalStore.setState({
      knownEnvironmentIds: [],
      byEnv: {},
    });

    renderPanel();

    expect(
      screen.getByText("Select an environment to open a terminal."),
    ).toBeInTheDocument();
    expect(mockedBridge.spawnTerminal).not.toHaveBeenCalled();
  });

  it("uses the project's local environment while the focused pane is a draft", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot(),
      layout: {
        slots: {
          topLeft: null,
          topRight: null,
          bottomLeft: null,
          bottomRight: null,
        },
        focusedSlot: null,
        rowRatio: 0.5,
        colRatio: 0.5,
      },
      draftBySlot: {},
      selectedProjectId: null,
      selectedEnvironmentId: null,
      selectedThreadId: null,
    }));
    useWorkspaceStore.getState().openThreadDraft("project-1");
    useTerminalStore.setState({
      knownEnvironmentIds: [ENV_ID],
      byEnv: {
        [ENV_ID]: makeSlot({ visible: true }),
      },
    });
    mockedBridge.spawnTerminal.mockClear();

    renderPanel();

    await waitFor(() => {
      expect(mockedBridge.spawnTerminal).toHaveBeenCalledWith({
        environmentId: ENV_ID,
        cols: 80,
        rows: 24,
      });
    });
    expect(useWorkspaceStore.getState().selectedEnvironmentId).toBeNull();
  });

  it("does not auto-bootstrap while the panel is hidden", async () => {
    const snapshotWithTwoEnvs = makeWorkspaceSnapshot();
    snapshotWithTwoEnvs.projects[0].environments.push({
      ...snapshotWithTwoEnvs.projects[0].environments[0],
      id: "env-2",
      name: "worktree-2",
      path: "/tmp/env-2",
    });
    useWorkspaceStore.setState({
      snapshot: snapshotWithTwoEnvs,
      bootstrapStatus: null,
      loadingState: "ready",
      error: null,
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
      selectedThreadId: null,
    });
    useTerminalStore.setState({
      knownEnvironmentIds: ["env-1", "env-2"],
      byEnv: {
        "env-1": makeSlot({ visible: false }),
        "env-2": makeSlot({ visible: false }),
      },
    });
    mockedBridge.spawnTerminal.mockClear();

    renderPanel();

    act(() => {
      useWorkspaceStore.setState({ selectedEnvironmentId: "env-2" });
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockedBridge.spawnTerminal).not.toHaveBeenCalled();
    expect(readSlot("env-1").tabs).toEqual([]);
    expect(readSlot("env-2").tabs).toEqual([]);
  });

  it("short-circuits bootstrap retry after spawn failure and resumes on hide/show", async () => {
    useTerminalStore.setState({
      knownEnvironmentIds: [ENV_ID],
      byEnv: {
        [ENV_ID]: makeSlot({ visible: true }),
      },
    });
    mockedBridge.spawnTerminal.mockReset();
    mockedBridge.spawnTerminal.mockRejectedValue(new Error("spawn failed"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { rerender } = renderPanel();

      // Wait for the first failure to propagate.
      await waitFor(() => {
        expect(mockedBridge.spawnTerminal).toHaveBeenCalledTimes(1);
      });

      // Give React a handful of render cycles to ensure the effect does NOT
      // re-fire in a tight loop after the failure.
      await new Promise((resolve) => setTimeout(resolve, 50));
      rerender(<TerminalPanel theme={PANEL_THEME} />);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockedBridge.spawnTerminal).toHaveBeenCalledTimes(1);

      // Hide + show: the failed-env cache resets and bootstrap retries once.
      useTerminalStore.getState().setVisible(ENV_ID, false);
      await new Promise((resolve) => setTimeout(resolve, 10));
      useTerminalStore.getState().setVisible(ENV_ID, true);
      await waitFor(() => {
        expect(mockedBridge.spawnTerminal).toHaveBeenCalledTimes(2);
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("deduplicates auto-bootstrap on the first strict-mode mount", async () => {
    useTerminalStore.setState({
      knownEnvironmentIds: [ENV_ID],
      byEnv: {
        [ENV_ID]: makeSlot({ visible: true }),
      },
    });

    render(
      <StrictMode>
        <TerminalPanel theme={PANEL_THEME} />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(mockedBridge.spawnTerminal).toHaveBeenCalledTimes(1);
    });
    expect(useTerminalStore.getState().byEnv[ENV_ID]?.tabs).toHaveLength(1);
  });

  it("retries bootstrap after switching away from a failed environment and back", async () => {
    const snapshotWithTwoEnvs = makeWorkspaceSnapshot();
    snapshotWithTwoEnvs.projects[0].environments.push({
      ...snapshotWithTwoEnvs.projects[0].environments[0],
      id: "env-2",
      name: "worktree-2",
      path: "/tmp/env-2",
    });
    useWorkspaceStore.setState({
      snapshot: snapshotWithTwoEnvs,
      bootstrapStatus: null,
      loadingState: "ready",
      error: null,
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
      selectedThreadId: null,
    });
    useTerminalStore.setState({
      knownEnvironmentIds: ["env-1", "env-2"],
      byEnv: {
        "env-2": makeSlot({
          tabs: [
            {
              id: "t3",
              ptyId: "pty-existing-3",
              cwd: "/tmp/env-2",
              title: "env-2",
              exited: false,
              kind: "shell",
            },
          ],
          activeTabId: "t3",
          visible: true,
        }),
        "env-1": makeSlot({ visible: true }),
      },
    });
    mockedBridge.spawnTerminal.mockReset();
    mockedBridge.spawnTerminal
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce({ ptyId: "pty-retry", cwd: "/tmp/env-1" });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      renderPanel();

      await waitFor(() => {
        expect(mockedBridge.spawnTerminal).toHaveBeenCalledTimes(1);
      });

      act(() => {
        useWorkspaceStore.setState({ selectedEnvironmentId: "env-2" });
      });
      act(() => {
        useWorkspaceStore.setState({ selectedEnvironmentId: "env-1" });
      });

      await waitFor(() => {
        expect(mockedBridge.spawnTerminal).toHaveBeenCalledTimes(2);
      });
      expect(mockedBridge.spawnTerminal).toHaveBeenNthCalledWith(2, {
        environmentId: "env-1",
        cols: 80,
        rows: 24,
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("bootstraps the newly selected env when the user switches during a pending spawn", async () => {
    // Seed env A with no tabs so the panel tries to auto-bootstrap.
    const snapshotWithTwoEnvs = makeWorkspaceSnapshot();
    snapshotWithTwoEnvs.projects[0].environments.push({
      ...snapshotWithTwoEnvs.projects[0].environments[0],
      id: "env-2",
      name: "worktree-2",
      path: "/tmp/env-2",
    });
    useWorkspaceStore.setState({
      snapshot: snapshotWithTwoEnvs,
      bootstrapStatus: null,
      loadingState: "ready",
      error: null,
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
      selectedThreadId: null,
    });
    useTerminalStore.setState({
      knownEnvironmentIds: ["env-1", "env-2"],
      byEnv: {
        "env-1": makeSlot({ visible: true }),
        "env-2": makeSlot({ visible: true }),
      },
    });

    // Control the first spawn so it stays pending.
    let resolveFirst: (value: { ptyId: string; cwd: string }) => void = () => {};
    const firstPending = new Promise<{ ptyId: string; cwd: string }>((resolve) => {
      resolveFirst = resolve;
    });
    mockedBridge.spawnTerminal
      .mockImplementationOnce(() => firstPending)
      .mockImplementationOnce(async ({ environmentId }) => ({
        ptyId: `pty-${environmentId}`,
        cwd: `/tmp/${environmentId}`,
      }));

    renderPanel();

    // Bootstrap for env-1 is in flight but not yet resolved.
    await waitFor(() => {
      expect(mockedBridge.spawnTerminal).toHaveBeenCalledTimes(1);
    });
    expect(mockedBridge.spawnTerminal).toHaveBeenNthCalledWith(1, {
      environmentId: "env-1",
      cols: 80,
      rows: 24,
    });

    // User switches to env-2 mid-spawn.
    act(() => {
      useWorkspaceStore.setState({ selectedEnvironmentId: "env-2" });
    });

    // Resolve the first spawn. The tab lands in byEnv["env-1"]. The effect
    // should then re-run for env-2 and trigger a second spawn.
    resolveFirst({ ptyId: "pty-1", cwd: "/tmp/env-1" });

    await waitFor(() => {
      expect(mockedBridge.spawnTerminal).toHaveBeenCalledTimes(2);
    });
    expect(mockedBridge.spawnTerminal).toHaveBeenNthCalledWith(2, {
      environmentId: "env-2",
      cols: 80,
      rows: 24,
    });

    await waitFor(() => {
      expect(useTerminalStore.getState().byEnv["env-2"]?.tabs.length).toBe(1);
    });
  });

  it("exposes the tab strip and actions with accessible semantics", async () => {
    const user = userEvent.setup();
    renderPanel();

    const tablist = screen.getByRole("tablist", { name: "Terminal tabs" });
    const firstTab = screen.getByRole("tab", { name: "a" });
    const secondTab = screen.getByRole("tab", { name: "b" });

    expect(tablist).toBeInTheDocument();
    expect(firstTab).toHaveAttribute("aria-selected", "true");
    expect(firstTab).toHaveAttribute("tabindex", "0");
    expect(secondTab).toHaveAttribute("aria-selected", "false");
    expect(secondTab).toHaveAttribute("tabindex", "-1");
    expect(
      screen.getByRole("button", { name: "New terminal" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Hide terminal" }),
    ).toBeInTheDocument();

    firstTab.focus();
    await user.keyboard("{ArrowRight}");

    await waitFor(() => {
      expect(useTerminalStore.getState().byEnv[ENV_ID]?.activeTabId).toBe("t2");
    });
    expect(secondTab).toHaveFocus();
  });
});
