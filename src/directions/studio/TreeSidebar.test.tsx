import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import {
  makeConversationSnapshot,
  makeEnvironment,
  makeProject,
  makeThread,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { useConversationStore } from "../../stores/conversation-store";
import { useWorktreeScriptStore } from "../../stores/worktree-script-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { TreeSidebar } from "./TreeSidebar";

const confirmMock = vi.fn();
const messageMock = vi.fn();
const openUrlMock = vi.fn();

vi.mock("../../lib/bridge", () => ({
  ensureProjectCanBeRemoved: vi.fn(),
  removeProject: vi.fn(),
  createManagedWorktree: vi.fn(),
  deleteWorktreeEnvironment: vi.fn(),
}));

vi.mock("../../shared/ProjectIcon", () => ({
  ProjectIcon: ({ name }: { name: string }) => <span>{name.slice(0, 1)}</span>,
}));

vi.mock("./useProjectImport", () => ({
  useProjectImport: () => ({
    error: null,
    clearError: vi.fn(),
    importProject: vi.fn(),
    isImporting: false,
  }),
}));

vi.mock("./SidebarUsagePanel", () => ({
  SidebarUsagePanel: () => <div data-testid="sidebar-usage-panel" />,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
  message: (...args: unknown[]) => messageMock(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

const mockedBridge = vi.mocked(bridge);
const onOpenSettings = vi.fn();
const onToggleTheme = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  messageMock.mockResolvedValue("Ok");
  openUrlMock.mockResolvedValue(undefined);
  mockedBridge.ensureProjectCanBeRemoved.mockResolvedValue(undefined);
  useConversationStore.setState((state) => ({
    ...state,
    snapshotsByThreadId: {},
    capabilitiesByEnvironmentId: {},
    composerByThreadId: {},
    loadingByThreadId: {},
    errorByThreadId: {},
    listenerReady: false,
  }));
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: makeWorkspaceSnapshot(),
    bootstrapStatus: null,
    loadingState: "ready",
    error: null,
    selectedProjectId: "project-1",
    selectedEnvironmentId: "env-1",
    selectedThreadId: "thread-1",
    refreshSnapshot: vi.fn(async () => true),
  }));
  useWorktreeScriptStore.setState({
    latestFailure: null,
    listenerReady: false,
  });
});

function renderSidebar() {
  return render(
    <TreeSidebar
      theme="dark"
      onOpenSettings={onOpenSettings}
      onToggleTheme={onToggleTheme}
    />,
  );
}

describe("TreeSidebar", () => {
  it("creates a managed worktree from the project-row plus button", async () => {
    const updatedSnapshot = makeWorkspaceSnapshot({
      projects: [
        makeProject({
          environments: [
            makeEnvironment({
              id: "env-local",
              kind: "local",
              isDefault: true,
              threads: [
                makeThread({ id: "thread-local", environmentId: "env-local" }),
              ],
            }),
            makeEnvironment({
              id: "env-worktree-new",
              kind: "managedWorktree",
              isDefault: false,
              name: "fuzzy-tiger",
              gitBranch: "fuzzy-tiger",
              path: "/Users/test/.loom/worktrees/loom/fuzzy-tiger",
              threads: [
                makeThread({
                  id: "thread-worktree-new",
                  environmentId: "env-worktree-new",
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const refreshSnapshot = vi.fn(async () => {
      useWorkspaceStore.setState((state) => ({
        ...state,
        snapshot: updatedSnapshot,
      }));
      return true;
    });
    useWorkspaceStore.setState((state) => ({
      ...state,
      refreshSnapshot,
    }));
    mockedBridge.createManagedWorktree.mockResolvedValue({
      environment: updatedSnapshot.projects[0].environments[1],
      thread: updatedSnapshot.projects[0].environments[1].threads[0],
    });

    renderSidebar();

    await userEvent.click(
      screen.getByRole("button", { name: "Create worktree for Loom" }),
    );

    await waitFor(() => {
      expect(mockedBridge.createManagedWorktree).toHaveBeenCalledWith(
        "project-1",
      );
    });
    expect(refreshSnapshot).toHaveBeenCalled();
    await waitFor(() => {
      expect(useWorkspaceStore.getState().selectedThreadId).toBe(
        "thread-worktree-new",
      );
    });
  });

  it("shows the updated project removal confirmation copy", async () => {
    confirmMock.mockResolvedValue(false);
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [makeEnvironment({ kind: "local", isDefault: true })],
          }),
        ],
      }),
    }));

    renderSidebar();

    fireEvent.contextMenu(
      screen.getAllByRole("button", { name: /Loom/i })[0],
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove from Loom" }),
    );

    expect(mockedBridge.ensureProjectCanBeRemoved).toHaveBeenCalledWith(
      "project-1",
    );
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining("The repository stays on disk."),
      expect.objectContaining({
        title: "Remove project",
      }),
    );
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "Loom may also remove its empty managed worktree folder.",
      ),
      expect.any(Object),
    );
    expect(mockedBridge.removeProject).not.toHaveBeenCalled();
  });

  it("blocks project removal before confirmation when managed worktrees still exist", async () => {
    mockedBridge.ensureProjectCanBeRemoved.mockRejectedValue({
      code: "validation_error",
      message:
        "Delete this project's worktrees before removing it from Loom.",
    });

    renderSidebar();

    fireEvent.contextMenu(
      screen.getAllByRole("button", { name: /Loom/i })[0],
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove from Loom" }),
    );

    expect(confirmMock).not.toHaveBeenCalled();
    expect(mockedBridge.ensureProjectCanBeRemoved).toHaveBeenCalledWith(
      "project-1",
    );
    expect(messageMock).toHaveBeenCalledWith(
      "Delete this project's worktrees before removing it from Loom.",
      expect.objectContaining({
        title: "Remove project",
        kind: "info",
      }),
    );
    expect(mockedBridge.removeProject).not.toHaveBeenCalled();
  });

  it("shows the native blocker dialog when project removal fails in the backend", async () => {
    confirmMock.mockResolvedValue(true);
    mockedBridge.removeProject.mockRejectedValue({
      code: "validation_error",
      message:
        "Delete this project's worktrees before removing it from Loom.",
    });
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [makeEnvironment({ kind: "local", isDefault: true })],
          }),
        ],
      }),
    }));

    renderSidebar();

    fireEvent.contextMenu(
      screen.getAllByRole("button", { name: /Loom/i })[0],
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove from Loom" }),
    );

    await waitFor(() => {
      expect(messageMock).toHaveBeenCalledWith(
        "Delete this project's worktrees before removing it from Loom.",
        expect.objectContaining({
          title: "Remove project",
          kind: "info",
        }),
      );
    });
  });

  it("keeps generic project removal failures in the sidebar notice", async () => {
    confirmMock.mockResolvedValue(true);
    mockedBridge.removeProject.mockRejectedValue(
      new Error("Disk is unavailable."),
    );

    renderSidebar();

    fireEvent.contextMenu(
      screen.getAllByRole("button", { name: /Loom/i })[0],
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove from Loom" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Disk is unavailable.")).toBeInTheDocument();
    });
  });

  it("shows a destructive confirmation before deleting a worktree", async () => {
    confirmMock.mockResolvedValue(false);
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
              }),
              makeEnvironment({
                id: "env-worktree",
                kind: "managedWorktree",
                name: "fuzzy-tiger",
                gitBranch: "fuzzy-tiger",
                path: "/Users/test/.loom/worktrees/loom/fuzzy-tiger",
                threads: [
                  makeThread({
                    id: "thread-active",
                    environmentId: "env-worktree",
                    status: "active",
                  }),
                  makeThread({
                    id: "thread-archived",
                    environmentId: "env-worktree",
                    status: "archived",
                    archivedAt: "2026-04-04T10:00:00Z",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    }));

    renderSidebar();

    fireEvent.contextMenu(screen.getByRole("button", { name: /fuzzy-tiger/i }));
    await userEvent.click(
      screen.getByRole("button", { name: "Delete worktree" }),
    );

    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining('Delete the worktree "fuzzy-tiger"?'),
      expect.objectContaining({
        title: "Delete worktree",
        okLabel: "Delete",
      }),
    );
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining("- 1 active thread"),
      expect.any(Object),
    );
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining("- 1 archived thread"),
      expect.any(Object),
    );
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining("- branch fuzzy-tiger"),
      expect.any(Object),
    );
    expect(mockedBridge.deleteWorktreeEnvironment).not.toHaveBeenCalled();
  });

  it("shows a waiting indicator on a worktree when any active thread awaits action", () => {
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
              }),
              makeEnvironment({
                id: "env-worktree",
                kind: "managedWorktree",
                name: "slate-hawk",
                gitBranch: "slate-hawk",
                threads: [
                  makeThread({
                    id: "thread-worktree-completed",
                    environmentId: "env-worktree",
                    updatedAt: "2026-04-03T08:00:00Z",
                  }),
                  makeThread({
                    id: "thread-worktree-waiting",
                    environmentId: "env-worktree",
                    updatedAt: "2026-04-03T09:00:00Z",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    }));
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: {
        "thread-worktree-completed": makeConversationSnapshot({
          threadId: "thread-worktree-completed",
          environmentId: "env-worktree",
          codexThreadId: "thr_completed",
          status: "completed",
          items: [],
          tokenUsage: null,
          pendingInteractions: [],
          proposedPlan: null,
        }),
        "thread-worktree-waiting": makeConversationSnapshot({
          threadId: "thread-worktree-waiting",
          environmentId: "env-worktree",
          codexThreadId: "thr_waiting",
          status: "waitingForExternalAction",
          items: [],
          tokenUsage: null,
          pendingInteractions: [],
          proposedPlan: null,
        }),
      },
    }));

    renderSidebar();

    const row = screen.getByRole("button", { name: /slate-hawk/i });
    expect(
      row.querySelector(".runtime-indicator__dot--waiting"),
    ).not.toBeNull();
  });

  it("shows a completed indicator for a stopped worktree with persisted chat history", () => {
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
              }),
              makeEnvironment({
                id: "env-worktree",
                kind: "managedWorktree",
                name: "slate-hawk",
                gitBranch: "slate-hawk",
                runtime: {
                  environmentId: "env-worktree",
                  state: "stopped",
                },
                threads: [
                  makeThread({
                    id: "thread-worktree",
                    environmentId: "env-worktree",
                    codexThreadId: "thr_completed",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    }));

    renderSidebar();

    const row = screen.getByRole("button", { name: /slate-hawk/i });
    expect(
      row.querySelector(".runtime-indicator__dot--completed"),
    ).not.toBeNull();
  });

  it("shows neutral indicators when local and worktree environments have no active threads", () => {
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
                threads: [
                  makeThread({
                    id: "thread-local-archived",
                    environmentId: "env-local",
                    codexThreadId: "thr_local_archived",
                    status: "archived",
                  }),
                ],
              }),
              makeEnvironment({
                id: "env-worktree",
                kind: "managedWorktree",
                name: "slate-hawk",
                gitBranch: "slate-hawk",
                threads: [
                  makeThread({
                    id: "thread-worktree-archived",
                    environmentId: "env-worktree",
                    codexThreadId: "thr_worktree_archived",
                    status: "archived",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    }));

    const { container } = renderSidebar();

    expect(
      container.querySelector(".project-group__header .runtime-indicator__dot--neutral"),
    ).not.toBeNull();
    const row = screen.getByRole("button", { name: /slate-hawk/i });
    expect(row.querySelector(".runtime-indicator__dot--neutral")).not.toBeNull();
    expect(
      row.querySelector(
        ".runtime-indicator__dot--progress, .runtime-indicator__dot--completed, .runtime-indicator__dot--warning",
      ),
    ).toBeNull();
  });

  it("opens the worktree pull request without changing the selected environment", async () => {
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
                threads: [
                  makeThread({
                    id: "thread-local",
                    environmentId: "env-local",
                  }),
                ],
              }),
              makeEnvironment({
                id: "env-worktree",
                kind: "managedWorktree",
                isDefault: false,
                name: "add-themes",
                gitBranch: "add-themes",
                pullRequest: {
                  number: 17,
                  title: "Add themes",
                  url: "https://github.com/acme/loom/pull/17",
                  state: "open",
                },
                threads: [
                  makeThread({
                    id: "thread-worktree",
                    environmentId: "env-worktree",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      selectedEnvironmentId: "env-local",
      selectedThreadId: "thread-local",
    }));

    renderSidebar();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Open pull request #17: Add themes",
      }),
    );

    expect(openUrlMock).toHaveBeenCalledWith(
      "https://github.com/acme/loom/pull/17",
    );
    expect(useWorkspaceStore.getState().selectedEnvironmentId).toBe(
      "env-local",
    );
  });

  it("keeps the worktree context menu available when right-clicking the pull request icon", () => {
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
              }),
              makeEnvironment({
                id: "env-worktree",
                kind: "managedWorktree",
                isDefault: false,
                name: "add-themes",
                gitBranch: "add-themes",
                pullRequest: {
                  number: 17,
                  title: "Add themes",
                  url: "https://github.com/acme/loom/pull/17",
                  state: "open",
                },
              }),
            ],
          }),
        ],
      }),
    }));

    renderSidebar();

    fireEvent.contextMenu(
      screen.getByRole("button", {
        name: "Open pull request #17: Add themes",
      }),
    );

    expect(
      screen.getByRole("button", { name: "Delete worktree" }),
    ).toBeInTheDocument();
  });

  it("renders merged pull request controls with a merged tooltip label", () => {
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
              }),
              makeEnvironment({
                id: "env-worktree",
                kind: "managedWorktree",
                isDefault: false,
                name: "release-cut",
                gitBranch: "release-cut",
                pullRequest: {
                  number: 29,
                  title: "Release cut",
                  url: "https://github.com/acme/loom/pull/29",
                  state: "merged",
                },
              }),
            ],
          }),
        ],
      }),
    }));

    renderSidebar();

    expect(
      screen.getByRole("button", {
        name: "Merged pull request #29: Release cut",
      }),
    ).toBeInTheDocument();
  });

  it("renders footer utility actions and forwards clicks", async () => {
    renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Light mode" }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });

  it("renders the latest worktree script failure notice", () => {
    useWorktreeScriptStore.setState({
      latestFailure: {
        trigger: "teardown",
        projectId: "project-1",
        projectName: "Loom",
        worktreeId: "env-worktree",
        worktreeName: "fuzzy-tiger",
        worktreeBranch: "fuzzy-tiger",
        worktreePath: "/tmp/fuzzy-tiger",
        message: 'Teardown script failed for "fuzzy-tiger" (exit code 1).',
        logPath: "/tmp/loom-script.log",
        exitCode: 1,
      },
      listenerReady: true,
    });

    renderSidebar();

    expect(
      screen.getByText("Teardown script failed for fuzzy-tiger"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Teardown script failed for "fuzzy-tiger" (exit code 1).',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("/tmp/loom-script.log")).toBeInTheDocument();
  });
});
