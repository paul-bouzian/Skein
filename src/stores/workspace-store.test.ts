import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import type { ProjectManualAction, WorkspaceEventPayload } from "../lib/types";
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
  updateProjectSettings: vi.fn(),
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
  vi.useRealTimers();
  teardownWorkspaceListener();
  useTerminalStore.setState({
    byEnv: {},
    knownEnvironmentIds: [],
  });
  mockedBridge.updateGlobalSettings.mockResolvedValue(makeGlobalSettings());
  mockedBridge.updateProjectSettings.mockResolvedValue(makeProject());
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
      layout: {
        slots: {
          topLeft: {
            projectId: "project-1",
            environmentId: "env-1",
            threadId: "thread-1",
          },
          topRight: null,
          bottomLeft: null,
          bottomRight: null,
        },
        focusedSlot: "topLeft",
        rowRatio: 0.5,
        colRatio: 0.5,
      },
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
      knownEnvironmentIds: ["env-local", "env-worktree"],
      byEnv: {
        "env-local": {
          tabs: [],
          activeTabId: null,
          visible: false,
          height: 280,
        },
        "env-worktree": {
          tabs: [
            {
              id: "terminal-1",
              ptyId: "pty-worktree",
              cwd: "/tmp/worktree",
              title: "worktree",
              exited: false,
              kind: "shell",
            },
          ],
          activeTabId: "terminal-1",
          visible: true,
          height: 280,
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
      layout: {
        slots: {
          topLeft: {
            projectId: "project-1",
            environmentId: "env-worktree",
            threadId: "thread-worktree",
          },
          topRight: null,
          bottomLeft: null,
          bottomRight: null,
        },
        focusedSlot: "topLeft",
        rowRatio: 0.5,
        colRatio: 0.5,
      },
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
              kind: "shell",
            },
          ],
          activeTabId: "terminal-1",
          visible: true,
          height: 280,
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

  it("updates project settings through the shared mutation helper", async () => {
    mockedBridge.updateProjectSettings.mockResolvedValue(
      makeProject({
        settings: {
          worktreeSetupScript: "pnpm install",
          worktreeTeardownScript: undefined,
          manualActions: [
            {
              id: "dev",
              label: "Dev",
              icon: "play",
              script: "bun run dev",
              shortcut: null,
            },
          ],
        },
      }),
    );
    mockedBridge.getWorkspaceSnapshot.mockResolvedValue(
      makeWorkspaceSnapshot({
        projects: [
          makeProject({
            settings: {
              worktreeSetupScript: "pnpm install",
              worktreeTeardownScript: undefined,
              manualActions: [
                {
                  id: "dev",
                  label: "Dev",
                  icon: "play",
                  script: "bun run dev",
                  shortcut: null,
                },
              ],
            },
          }),
        ],
      }),
    );
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot(),
    }));

    const result = await useWorkspaceStore.getState().updateProjectSettings("project-1", {
      worktreeSetupScript: "pnpm install",
      worktreeTeardownScript: null,
      manualActions: [
        {
          id: "dev",
          label: "Dev",
          icon: "play",
          script: "bun run dev",
          shortcut: null,
        },
      ],
    });

    expect(mockedBridge.updateProjectSettings).toHaveBeenCalledWith({
      projectId: "project-1",
      patch: {
        worktreeSetupScript: "pnpm install",
        worktreeTeardownScript: null,
        manualActions: [
          {
            id: "dev",
            label: "Dev",
            icon: "play",
            script: "bun run dev",
            shortcut: null,
          },
        ],
      },
    });
    expect(result).toEqual({
      ok: true,
      refreshed: true,
      warningMessage: null,
      errorMessage: null,
      project: makeProject({
        settings: {
          worktreeSetupScript: "pnpm install",
          worktreeTeardownScript: undefined,
          manualActions: [
            {
              id: "dev",
              label: "Dev",
              icon: "play",
              script: "bun run dev",
              shortcut: null,
            },
          ],
        },
      }),
    });
    expect(
      useWorkspaceStore.getState().snapshot?.projects[0]?.settings.manualActions,
    ).toEqual([
      {
        id: "dev",
        label: "Dev",
        icon: "play",
        script: "bun run dev",
        shortcut: null,
      },
    ]);
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

  it("returns a warning when project settings save succeeds but refresh fails", async () => {
    const expectedManualActions: ProjectManualAction[] = [
      {
        id: "dev",
        label: "Dev",
        icon: "play",
        script: "bun run dev",
        shortcut: null,
      },
    ];
    const pullRequest = {
      number: 66,
      title: "studio: add inline project action creation from the toolbar",
      url: "https://github.com/paul-bouzian/Skein/pull/66",
      state: "open" as const,
    };
    mockedBridge.updateProjectSettings.mockResolvedValue(
      makeProject({
        settings: {
          worktreeSetupScript: undefined,
          worktreeTeardownScript: undefined,
          manualActions: expectedManualActions,
        },
        environments: [
          makeEnvironment({
            runtime: {
              environmentId: "env-1",
              state: "stopped",
              pid: undefined,
              binaryPath: undefined,
              startedAt: undefined,
              lastExitCode: 1,
            },
            pullRequest: undefined,
          }),
        ],
      }),
    );
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [
              makeEnvironment({
                pullRequest,
              }),
            ],
          }),
        ],
      }),
      refreshSnapshot: vi.fn(async () => false),
    }));

    const result = await useWorkspaceStore.getState().updateProjectSettings("project-1", {
      worktreeSetupScript: null,
      worktreeTeardownScript: null,
      manualActions: expectedManualActions,
    });

    expect(result).toEqual({
      ok: true,
      refreshed: false,
      warningMessage:
        "Project settings were saved, but the workspace snapshot could not be refreshed.",
      errorMessage: null,
      project: makeProject({
        settings: {
          worktreeSetupScript: undefined,
          worktreeTeardownScript: undefined,
          manualActions: expectedManualActions,
        },
        environments: [
          makeEnvironment({
            runtime: {
              environmentId: "env-1",
              state: "stopped",
              pid: undefined,
              binaryPath: undefined,
              startedAt: undefined,
              lastExitCode: 1,
            },
            pullRequest: undefined,
          }),
        ],
      }),
    });
    expect(
      useWorkspaceStore.getState().snapshot?.projects[0]?.settings.manualActions,
    ).toEqual(expectedManualActions);
    expect(
      useWorkspaceStore.getState().snapshot?.projects[0]?.environments[0]?.runtime.state,
    ).toBe("running");
    expect(
      useWorkspaceStore.getState().snapshot?.projects[0]?.environments[0]?.pullRequest,
    ).toEqual(pullRequest);
    expect(useWorkspaceStore.getState().error).toBe(
      "Project settings were saved, but the workspace snapshot could not be refreshed.",
    );
  });

  it("fails fast when project settings save returns no project", async () => {
    mockedBridge.updateProjectSettings.mockResolvedValueOnce(null as never);
    const refreshSnapshot = vi.fn(async () => true);
    useWorkspaceStore.setState((state) => ({
      ...state,
      refreshSnapshot,
    }));

    const result = await useWorkspaceStore
      .getState()
      .updateProjectSettings("project-1", { manualActions: [] });

    expect(result).toEqual({
      ok: false,
      refreshed: false,
      warningMessage: null,
      errorMessage: "Failed to save project settings",
      project: null,
    });
    expect(refreshSnapshot).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().error).toBe("Failed to save project settings");
  });

  it("debounces workspace refreshes when workspace events arrive in a burst", async () => {
    vi.useFakeTimers();
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
    handler({ kind: "runtimeStatusChanged" });

    expect(mockedBridge.getWorkspaceSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(mockedBridge.getWorkspaceSnapshot).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().listenerReady).toBe(true);
  });
});

describe("workspace store — grid 2x2 panes", () => {
  function seedTwoThreadWorkspace() {
    const snapshot = makeWorkspaceSnapshot({
      projects: [
        makeProject({
          id: "project-a",
          environments: [
            makeEnvironment({
              id: "env-a",
              projectId: "project-a",
              kind: "local",
              isDefault: true,
              threads: [
                makeThread({ id: "thread-a-1", environmentId: "env-a" }),
                makeThread({ id: "thread-a-2", environmentId: "env-a" }),
              ],
            }),
          ],
        }),
        makeProject({
          id: "project-b",
          environments: [
            makeEnvironment({
              id: "env-b",
              projectId: "project-b",
              kind: "local",
              isDefault: true,
              threads: [
                makeThread({ id: "thread-b-1", environmentId: "env-b" }),
              ],
            }),
          ],
        }),
      ],
    });
    useWorkspaceStore.setState((state) => ({ ...state, snapshot }));
    return snapshot;
  }

  function slots() {
    return useWorkspaceStore.getState().layout.slots;
  }

  it("dropping into an empty layout seeds the first pane in topLeft", () => {
    seedTwoThreadWorkspace();

    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-a-1");

    expect(slots().topLeft?.threadId).toBe("thread-a-1");
    expect(slots().topRight).toBeNull();
    expect(slots().bottomLeft).toBeNull();
    expect(useWorkspaceStore.getState().layout.focusedSlot).toBe("topLeft");
  });

  it("drop right on a single pane splits into a row", () => {
    seedTwoThreadWorkspace();
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-a-1");

    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-b-1");

    expect(slots().topLeft?.threadId).toBe("thread-a-1");
    expect(slots().topRight?.threadId).toBe("thread-b-1");
    expect(slots().bottomLeft).toBeNull();
  });

  it("drop top on a 2-pane row shifts existing panes to bottom", () => {
    seedTwoThreadWorkspace();
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-a-1");
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-b-1");

    useWorkspaceStore.getState().dropThreadInDirection("top", "thread-a-2");

    expect(slots().topLeft?.threadId).toBe("thread-a-2");
    expect(slots().topRight).toBeNull();
    expect(slots().bottomLeft?.threadId).toBe("thread-a-1");
    expect(slots().bottomRight?.threadId).toBe("thread-b-1");
  });

  it("drop left on a 2-pane column shifts existing panes to the right col", () => {
    seedTwoThreadWorkspace();
    useWorkspaceStore.getState().dropThreadInDirection("top", "thread-a-1");
    useWorkspaceStore.getState().dropThreadInDirection("bottom", "thread-b-1");
    // Now primary=col: topLeft=a-1, bottomLeft=b-1.

    useWorkspaceStore.getState().dropThreadInDirection("left", "thread-a-2");

    expect(slots().topLeft?.threadId).toBe("thread-a-2");
    expect(slots().topRight?.threadId).toBe("thread-a-1");
    expect(slots().bottomLeft).toBeNull();
    expect(slots().bottomRight?.threadId).toBe("thread-b-1");
  });

  it("drop on a 3-pane layout fills the matching empty slot", () => {
    seedTwoThreadWorkspace();
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-a-1");
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-b-1");
    useWorkspaceStore.getState().dropThreadInDirection("bottom", "thread-a-2");
    // Now slots: TL=a-1, TR=b-1, BL=a-2, BR=null.

    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-a-1");

    expect(slots().topLeft?.threadId).toBe("thread-a-1");
    expect(slots().topRight?.threadId).toBe("thread-b-1");
    expect(slots().bottomLeft?.threadId).toBe("thread-a-2");
    expect(slots().bottomRight?.threadId).toBe("thread-a-1");
  });

  it("rejects drops in incompatible directions when 3 panes are placed", () => {
    seedTwoThreadWorkspace();
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-a-1");
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-b-1");
    useWorkspaceStore.getState().dropThreadInDirection("bottom", "thread-a-2");
    // BR is empty. Valid directions to fill BR = {bottom, right}. Try "top".

    useWorkspaceStore.getState().dropThreadInDirection("top", "thread-a-1");

    expect(slots().bottomRight).toBeNull();
  });

  it("openThreadInOtherPane places the new pane in the neighbor slot", () => {
    seedTwoThreadWorkspace();
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-a-1");

    useWorkspaceStore.getState().openThreadInOtherPane("thread-a-1");

    expect(slots().topLeft?.threadId).toBe("thread-a-1");
    expect(slots().topRight?.threadId).toBe("thread-a-1");
  });

  it("closePane removes the slot and compacts remaining panes", () => {
    seedTwoThreadWorkspace();
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-a-1");
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-b-1");

    useWorkspaceStore.getState().closePane("topRight");

    expect(slots().topLeft?.threadId).toBe("thread-a-1");
    expect(slots().topRight).toBeNull();
  });

  it("enforces the maximum pane count", () => {
    seedTwoThreadWorkspace();
    const store = useWorkspaceStore.getState;
    store().dropThreadInDirection("right", "thread-a-1");
    store().dropThreadInDirection("right", "thread-b-1");
    store().dropThreadInDirection("bottom", "thread-a-2");
    store().dropThreadInDirection("bottom", "thread-a-1");
    expect(Object.values(slots()).filter(Boolean)).toHaveLength(4);

    // 5th rejected.
    store().dropThreadInDirection("bottom", "thread-a-2");
    expect(Object.values(slots()).filter(Boolean)).toHaveLength(4);
  });

  it("setRowRatio clamps values between 0.35 and 0.65", () => {
    useWorkspaceStore.getState().setRowRatio(0.05);
    expect(useWorkspaceStore.getState().layout.rowRatio).toBe(0.35);

    useWorkspaceStore.getState().setRowRatio(0.95);
    expect(useWorkspaceStore.getState().layout.rowRatio).toBe(0.65);
  });

  it("reconcile removes panes whose thread disappears from the snapshot", async () => {
    const snapshot = seedTwoThreadWorkspace();
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-a-1");
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-b-1");

    const refreshedSnapshot = makeWorkspaceSnapshot({
      projects: [snapshot.projects[0]!],
    });
    mockedBridge.getWorkspaceSnapshot.mockResolvedValue(refreshedSnapshot);

    await useWorkspaceStore.getState().refreshSnapshot();

    expect(slots().topLeft?.threadId).toBe("thread-a-1");
    expect(slots().topRight).toBeNull();
  });

  it("selectThread routes to the focused slot", () => {
    seedTwoThreadWorkspace();
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-a-1");
    useWorkspaceStore.getState().dropThreadInDirection("right", "thread-b-1");
    // The new right pane is focused.

    useWorkspaceStore.getState().selectThread("thread-a-2");

    expect(slots().topLeft?.threadId).toBe("thread-a-1");
    expect(slots().topRight?.threadId).toBe("thread-a-2");
  });
});
