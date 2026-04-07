import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import type { WorkspaceEventPayload } from "../lib/types";
import { makeEnvironment, makeProject, makeThread, makeWorkspaceSnapshot } from "../test/fixtures/conversation";
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
}));

vi.mock("../lib/terminal-output-bus", () => ({
  ensureTerminalOutputBusReady: vi.fn().mockResolvedValue(undefined),
  dropPendingTerminalOutput: vi.fn(),
  subscribeToTerminalOutput: vi.fn(() => () => {}),
  __resetTerminalOutputBus: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);

beforeEach(() => {
  vi.clearAllMocks();
  teardownWorkspaceListener();
  useTerminalStore.setState({
    visible: false,
    height: 280,
    byEnv: {},
    knownEnvironmentIds: [],
  });
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: null,
    bootstrapStatus: null,
    loadingState: "ready",
    error: null,
    listenerReady: false,
    selectedProjectId: null,
    selectedEnvironmentId: null,
    selectedThreadId: null,
  }));
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
