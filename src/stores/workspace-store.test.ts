import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import type { WorkspaceEventPayload } from "../lib/types";
import {
  makeEnvironment,
  makeGlobalSettings,
  makeProject,
  makeThread,
  makeWorkspaceSnapshot,
} from "../test/fixtures/conversation";
import { useTerminalStore } from "./terminal-store";
import {
  teardownWorkspaceListener,
  useWorkspaceStore,
} from "./workspace-store";

vi.mock("../lib/bridge", () => ({
  getBootstrapStatus: vi.fn(),
  getWorkspaceSnapshot: vi.fn(),
  listenToWorkspaceEvents: vi.fn(),
  killTerminal: vi.fn().mockResolvedValue(undefined),
  updateGlobalSettings: vi.fn(),
  reorderProjects: vi.fn(),
  reorderWorktreeEnvironments: vi.fn(),
  setProjectSidebarCollapsed: vi.fn(),
}));

vi.mock("../lib/terminal-output-bus", () => ({
  ensureTerminalOutputBusReady: vi.fn().mockResolvedValue(undefined),
  dropPendingTerminalOutput: vi.fn(),
  subscribeToTerminalOutput: vi.fn(() => () => {}),
  __resetTerminalOutputBus: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);
const initialWorkspaceState = useWorkspaceStore.getInitialState();

beforeEach(() => {
  vi.clearAllMocks();
  teardownWorkspaceListener();
  useTerminalStore.setState({
    visible: false,
    height: 280,
    byEnv: {},
    knownEnvironmentIds: [],
  });
  mockedBridge.updateGlobalSettings.mockResolvedValue(makeGlobalSettings());
  useWorkspaceStore.setState(initialWorkspaceState, true);
  useWorkspaceStore.setState({ loadingState: "ready" });
});

describe("workspace store", () => {
  it("maps project selection to the local environment and latest active thread", () => {
    const snapshot = makeWorkspaceSnapshot({
      projects: [
        makeProject({
          environments: [
            makeEnvironment({
              id: "env-local",
              kind: "local",
              isDefault: true,
              threads: [
                makeThread({
                  id: "thread-local-older",
                  environmentId: "env-local",
                  updatedAt: "2026-04-03T08:00:00Z",
                }),
                makeThread({
                  id: "thread-local-latest",
                  environmentId: "env-local",
                  updatedAt: "2026-04-03T09:30:00Z",
                }),
              ],
            }),
            makeEnvironment({
              id: "env-worktree",
              kind: "managedWorktree",
              isDefault: false,
              threads: [],
            }),
          ],
        }),
      ],
    });

    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot,
    }));

    useWorkspaceStore.getState().selectProject("project-1");

    const state = useWorkspaceStore.getState();
    expect(state.selectedProjectId).toBe("project-1");
    expect(state.selectedEnvironmentId).toBe("env-local");
    expect(state.selectedThreadId).toBe("thread-local-latest");
  });

  it("selects the most recent active thread when an environment is chosen", () => {
    const snapshot = makeWorkspaceSnapshot({
      projects: [
        makeProject({
          environments: [
            makeEnvironment({
              threads: [
                makeThread({
                  id: "thread-older",
                  updatedAt: "2026-04-03T08:00:00Z",
                }),
                makeThread({
                  id: "thread-latest",
                  updatedAt: "2026-04-03T09:30:00Z",
                }),
              ],
            }),
          ],
        }),
      ],
    });

    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot,
    }));

    useWorkspaceStore.getState().selectEnvironment("env-1");

    const state = useWorkspaceStore.getState();
    expect(state.selectedProjectId).toBe("project-1");
    expect(state.selectedEnvironmentId).toBe("env-1");
    expect(state.selectedThreadId).toBe("thread-latest");
  });

  it("keeps the environment selected when clearing the active thread", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot(),
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
      selectedThreadId: "thread-1",
    }));

    useWorkspaceStore.getState().selectThread(null);

    const state = useWorkspaceStore.getState();
    expect(state.selectedProjectId).toBe("project-1");
    expect(state.selectedEnvironmentId).toBe("env-1");
    expect(state.selectedThreadId).toBeNull();
  });

  it("falls back to the local environment when a selected worktree disappears on refresh", async () => {
    useTerminalStore.setState({
      visible: true,
      height: 280,
      knownEnvironmentIds: ["env-local", "env-worktree"],
      byEnv: {
        "env-local": {
          tabs: [],
          activeTabId: null,
        },
        "env-worktree": {
          tabs: [
            {
              id: "terminal-1",
              ptyId: "pty-worktree",
              cwd: "/tmp/worktree",
              title: "worktree",
              exited: false,
            },
          ],
          activeTabId: "terminal-1",
        },
      },
    });
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [
              makeEnvironment({
                id: "env-local",
                kind: "local",
                isDefault: true,
                threads: [makeThread({ id: "thread-local", environmentId: "env-local" })],
              }),
              makeEnvironment({
                id: "env-worktree",
                kind: "managedWorktree",
                isDefault: false,
                threads: [makeThread({ id: "thread-worktree", environmentId: "env-worktree" })],
              }),
            ],
          }),
        ],
      }),
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-worktree",
      selectedThreadId: "thread-worktree",
    }));
    mockedBridge.getWorkspaceSnapshot.mockResolvedValue(
      makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [
              makeEnvironment({
                id: "env-local",
                kind: "local",
                isDefault: true,
                threads: [makeThread({ id: "thread-local", environmentId: "env-local" })],
              }),
            ],
          }),
        ],
      }),
    );

    await useWorkspaceStore.getState().refreshSnapshot();

    const state = useWorkspaceStore.getState();
    expect(state.selectedProjectId).toBe("project-1");
    expect(state.selectedEnvironmentId).toBe("env-local");
    expect(state.selectedThreadId).toBe("thread-local");
    expect(useTerminalStore.getState().byEnv["env-worktree"]).toBeUndefined();
  });

  it("returns false and stores an error when refresh fails", async () => {
    mockedBridge.getWorkspaceSnapshot.mockRejectedValue(new Error("snapshot unavailable"));

    await expect(useWorkspaceStore.getState().refreshSnapshot()).resolves.toBe(
      false,
    );

    expect(useWorkspaceStore.getState().error).toBe("snapshot unavailable");
  });

  it.each([
    {
      label: "reorderProjects",
      run: () =>
        useWorkspaceStore.getState().reorderProjects(["project-2", "project-1"]),
      assertBridgeCall: () =>
        expect(mockedBridge.reorderProjects).toHaveBeenCalledWith({
          projectIds: ["project-2", "project-1"],
        }),
      reject: () => mockedBridge.reorderProjects.mockRejectedValueOnce(new Error("project reorder failed")),
    },
    {
      label: "reorderWorktreeEnvironments",
      run: () =>
        useWorkspaceStore
          .getState()
          .reorderWorktreeEnvironments("project-1", ["env-2", "env-1"]),
      assertBridgeCall: () =>
        expect(mockedBridge.reorderWorktreeEnvironments).toHaveBeenCalledWith({
          projectId: "project-1",
          environmentIds: ["env-2", "env-1"],
        }),
      reject: () =>
        mockedBridge.reorderWorktreeEnvironments.mockRejectedValueOnce(
          new Error("worktree reorder failed"),
        ),
    },
    {
      label: "setProjectSidebarCollapsed",
      run: () =>
        useWorkspaceStore
          .getState()
          .setProjectSidebarCollapsed("project-1", true),
      assertBridgeCall: () =>
        expect(mockedBridge.setProjectSidebarCollapsed).toHaveBeenCalledWith({
          projectId: "project-1",
          collapsed: true,
        }),
      reject: () =>
        mockedBridge.setProjectSidebarCollapsed.mockRejectedValueOnce(
          new Error("collapse update failed"),
        ),
    },
  ])("$label refreshes the workspace and clears stale errors on success", async ({
    run,
    assertBridgeCall,
  }) => {
    const refreshSnapshot = vi.fn(async () => true);
    useWorkspaceStore.setState((state) => ({
      ...state,
      error: "stale error",
      refreshSnapshot,
    }));

    await expect(run()).resolves.toEqual({
      ok: true,
      refreshed: true,
      warningMessage: null,
      errorMessage: null,
    });

    assertBridgeCall();
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().error).toBeNull();
  });

  it.each([
    {
      label: "reorderProjects",
      run: () =>
        useWorkspaceStore.getState().reorderProjects(["project-2", "project-1"]),
      reject: () =>
        mockedBridge.reorderProjects.mockRejectedValueOnce(
          new Error("project reorder failed"),
        ),
      expectedError: "project reorder failed",
    },
    {
      label: "reorderWorktreeEnvironments",
      run: () =>
        useWorkspaceStore
          .getState()
          .reorderWorktreeEnvironments("project-1", ["env-2", "env-1"]),
      reject: () =>
        mockedBridge.reorderWorktreeEnvironments.mockRejectedValueOnce(
          new Error("worktree reorder failed"),
        ),
      expectedError: "worktree reorder failed",
    },
    {
      label: "setProjectSidebarCollapsed",
      run: () =>
        useWorkspaceStore
          .getState()
          .setProjectSidebarCollapsed("project-1", true),
      reject: () =>
        mockedBridge.setProjectSidebarCollapsed.mockRejectedValueOnce(
          new Error("collapse update failed"),
        ),
      expectedError: "collapse update failed",
    },
  ])("$label stores bridge errors and skips refresh on failure", async ({
    run,
    reject,
    expectedError,
  }) => {
    const refreshSnapshot = vi.fn(async () => true);
    useWorkspaceStore.setState((state) => ({
      ...state,
      refreshSnapshot,
    }));
    reject();

    await expect(run()).resolves.toEqual({
      ok: false,
      refreshed: false,
      warningMessage: null,
      errorMessage: expectedError,
    });

    expect(refreshSnapshot).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().error).toBe(expectedError);
  });

  it.each([
    {
      label: "reorderProjects",
      setupSnapshot: () =>
        makeWorkspaceSnapshot({
          projects: [
            makeProject({ id: "project-1", name: "First" }),
            makeProject({ id: "project-2", name: "Second" }),
          ],
        }),
      run: () =>
        useWorkspaceStore.getState().reorderProjects(["project-2", "project-1"]),
      expectedWarning: "Project order saved, but the workspace failed to refresh.",
      assertSnapshot: () =>
        expect(
          useWorkspaceStore.getState().snapshot?.projects.map((project) => project.id),
        ).toEqual(["project-2", "project-1"]),
    },
    {
      label: "reorderWorktreeEnvironments",
      setupSnapshot: () =>
        makeWorkspaceSnapshot({
          projects: [
            makeProject({
              id: "project-1",
              environments: [
                makeEnvironment({
                  id: "env-local",
                  projectId: "project-1",
                  kind: "local",
                  isDefault: true,
                }),
                makeEnvironment({
                  id: "env-1",
                  projectId: "project-1",
                  kind: "managedWorktree",
                  isDefault: false,
                }),
                makeEnvironment({
                  id: "env-2",
                  projectId: "project-1",
                  kind: "managedWorktree",
                  isDefault: false,
                }),
              ],
            }),
          ],
        }),
      run: () =>
        useWorkspaceStore
          .getState()
          .reorderWorktreeEnvironments("project-1", ["env-2", "env-1"]),
      expectedWarning: "Worktree order saved, but the workspace failed to refresh.",
      assertSnapshot: () =>
        expect(
          useWorkspaceStore.getState().snapshot?.projects[0]?.environments.map(
            (environment) => environment.id,
          ),
        ).toEqual(["env-local", "env-2", "env-1"]),
    },
    {
      label: "setProjectSidebarCollapsed",
      setupSnapshot: () =>
        makeWorkspaceSnapshot({
          projects: [makeProject({ id: "project-1", sidebarCollapsed: false })],
        }),
      run: () =>
        useWorkspaceStore
          .getState()
          .setProjectSidebarCollapsed("project-1", true),
      expectedWarning:
        "Project collapse state saved, but the workspace failed to refresh.",
      assertSnapshot: () =>
        expect(useWorkspaceStore.getState().snapshot?.projects[0]?.sidebarCollapsed).toBe(
          true,
        ),
    },
  ])(
    "$label keeps the local snapshot aligned when refresh fails after a successful write",
    async ({ setupSnapshot, run, expectedWarning, assertSnapshot }) => {
      const refreshSnapshot = vi.fn(async () => false);
      useWorkspaceStore.setState((state) => ({
        ...state,
        snapshot: setupSnapshot(),
        refreshSnapshot,
      }));

      await expect(run()).resolves.toEqual({
        ok: true,
        refreshed: false,
        warningMessage: expectedWarning,
        errorMessage: null,
      });

      expect(refreshSnapshot).toHaveBeenCalledTimes(1);
      assertSnapshot();
      expect(useWorkspaceStore.getState().error).toBe(expectedWarning);
    },
  );

  it("refreshSnapshot updates terminal cwd metadata when an environment path changes", async () => {
    useTerminalStore.setState({
      visible: true,
      height: 280,
      knownEnvironmentIds: ["env-worktree"],
      byEnv: {
        "env-worktree": {
          tabs: [
            {
              id: "terminal-1",
              ptyId: "pty-worktree",
              cwd: "/tmp/old-worktree",
              title: "old-worktree",
              exited: false,
            },
          ],
          activeTabId: "terminal-1",
        },
      },
    });
    mockedBridge.getWorkspaceSnapshot.mockResolvedValue(
      makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [
              makeEnvironment({
                id: "env-worktree",
                kind: "managedWorktree",
                isDefault: false,
                name: "Add themes",
                path: "/tmp/add-themes",
                gitBranch: "add-themes",
                threads: [makeThread({ environmentId: "env-worktree" })],
              }),
            ],
          }),
        ],
      }),
    );

    await useWorkspaceStore.getState().refreshSnapshot();

    const tab = useTerminalStore.getState().byEnv["env-worktree"]?.tabs[0];
    expect(tab?.cwd).toBe("/tmp/add-themes");
    expect(tab?.title).toBe("add-themes");
  });

  it("updates global settings through the shared mutation helper", async () => {
    mockedBridge.updateGlobalSettings.mockResolvedValue(
      makeGlobalSettings({
        defaultOpenTargetId: "zed",
      }),
    );
    mockedBridge.getWorkspaceSnapshot.mockResolvedValue(
      makeWorkspaceSnapshot({
        settings: makeGlobalSettings({
          defaultOpenTargetId: "zed",
        }),
      }),
    );
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot(),
    }));

    const result = await useWorkspaceStore
      .getState()
      .updateGlobalSettings({ defaultOpenTargetId: "zed" });

    expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledWith({
      defaultOpenTargetId: "zed",
    });
    expect(result).toEqual({
      ok: true,
      refreshed: true,
      warningMessage: null,
      errorMessage: null,
      settings: makeGlobalSettings({
        defaultOpenTargetId: "zed",
      }),
    });
    expect(
      useWorkspaceStore.getState().snapshot?.settings.defaultOpenTargetId,
    ).toBe("zed");
  });

  it("returns a warning when settings save succeeds but refresh fails", async () => {
    mockedBridge.updateGlobalSettings.mockResolvedValue(makeGlobalSettings());
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot(),
      refreshSnapshot: vi.fn(async () => false),
    }));

    const result = await useWorkspaceStore
      .getState()
      .updateGlobalSettings({ defaultOpenTargetId: "file-manager" });

    expect(result).toEqual({
      ok: true,
      refreshed: false,
      warningMessage:
        "Settings were saved, but the workspace snapshot could not be refreshed.",
      errorMessage: null,
      settings: makeGlobalSettings(),
    });
  });

  it("refreshes the workspace when a workspace event arrives", async () => {
    let handler: ((payload: WorkspaceEventPayload) => void) | undefined;
    mockedBridge.listenToWorkspaceEvents.mockImplementation(async (callback) => {
      handler = callback;
      return () => undefined;
    });
    mockedBridge.getWorkspaceSnapshot.mockResolvedValue(makeWorkspaceSnapshot());

    await useWorkspaceStore.getState().initializeListener();
    if (typeof handler !== "function") {
      throw new Error("Expected workspace listener handler");
    }
    handler({ kind: "environmentRenamed" });
    await Promise.resolve();

    expect(mockedBridge.getWorkspaceSnapshot).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().listenerReady).toBe(true);
  });
});
