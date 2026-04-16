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
  reorderProjects: vi.fn(),
  setProjectSidebarCollapsed: vi.fn(),
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
  mockedBridge.reorderProjects.mockResolvedValue(undefined);
  mockedBridge.setProjectSidebarCollapsed.mockResolvedValue(undefined);
  useConversationStore.setState((state) => ({
    ...state,
    snapshotsByThreadId: {},
    capabilitiesByEnvironmentId: {},
    composerByThreadId: {},
    hydrationByThreadId: {},
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

function textContentList(elements: NodeListOf<Element>) {
  return Array.from(elements, (element) => element.textContent);
}

function stubVerticalRects(
  elements: HTMLElement[],
  { top = 0, height = 32, gap = 8 } = {},
) {
  elements.forEach((element, index) => {
    const itemTop = top + index * (height + gap);
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: itemTop,
      top: itemTop,
      left: 0,
      width: 280,
      height,
      right: 280,
      bottom: itemTop + height,
      toJSON: vi.fn(),
    });
  });
}

function createDeferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function makeProjectWithLocalAndWorktree() {
  return makeProject({
    environments: [
      makeEnvironment({
        id: "env-local",
        kind: "local",
        isDefault: true,
        threads: [
          makeThread({
            id: "thread-local",
            environmentId: "env-local",
            title: "Local thread",
          }),
        ],
      }),
      makeEnvironment({
        id: "env-worktree",
        kind: "managedWorktree",
        name: "fuzzy-tiger",
        gitBranch: "fuzzy-tiger",
        threads: [
          makeThread({
            id: "thread-worktree",
            environmentId: "env-worktree",
            title: "Worktree thread",
          }),
        ],
      }),
    ],
  });
}

describe("TreeSidebar", () => {
  it.skip("creates a managed worktree from the project-row plus button", async () => {
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
              path: "/Users/test/.skein/worktrees/skein/fuzzy-tiger",
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
      screen.getByRole("button", { name: "Create worktree for Skein" }),
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
    expect(mockedBridge.reorderProjects).not.toHaveBeenCalled();
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
      screen.getAllByRole("button", { name: /Skein/i })[0],
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove from Skein" }),
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
        "Skein may also remove its empty managed worktree folder.",
      ),
      expect.any(Object),
    );
    expect(mockedBridge.removeProject).not.toHaveBeenCalled();
  });

  it("collapses a non-selected project from the project row", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            id: "project-alpha",
            name: "Alpha",
            environments: [
              makeEnvironment({
                id: "env-alpha",
                projectId: "project-alpha",
                kind: "local",
                isDefault: true,
                threads: [
                  makeThread({
                    id: "thread-alpha",
                    environmentId: "env-alpha",
                  }),
                ],
              }),
            ],
          }),
          makeProject({
            id: "project-beta",
            name: "Beta",
            environments: [
              makeEnvironment({
                id: "env-beta",
                projectId: "project-beta",
                kind: "local",
                isDefault: true,
                threads: [
                  makeThread({
                    id: "thread-beta",
                    environmentId: "env-beta",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      selectedProjectId: "project-beta",
      selectedEnvironmentId: "env-beta",
      selectedThreadId: "thread-beta",
    }));

    renderSidebar();

    await userEvent.click(screen.getByText("Alpha").closest("button")!);

    expect(mockedBridge.setProjectSidebarCollapsed).toHaveBeenCalledWith({
      projectId: "project-alpha",
      collapsed: true,
    });
    expect(mockedBridge.reorderProjects).not.toHaveBeenCalled();
  });

  it("blocks project removal before confirmation when managed worktrees still exist", async () => {
    mockedBridge.ensureProjectCanBeRemoved.mockRejectedValue({
      code: "validation_error",
      message:
        "Delete this project's worktrees before removing it from Skein.",
    });

    renderSidebar();

    fireEvent.contextMenu(
      screen.getAllByRole("button", { name: /Skein/i })[0],
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove from Skein" }),
    );

    expect(confirmMock).not.toHaveBeenCalled();
    expect(mockedBridge.ensureProjectCanBeRemoved).toHaveBeenCalledWith(
      "project-1",
    );
    expect(messageMock).toHaveBeenCalledWith(
      "Delete this project's worktrees before removing it from Skein.",
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
        "Delete this project's worktrees before removing it from Skein.",
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
      screen.getAllByRole("button", { name: /Skein/i })[0],
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove from Skein" }),
    );

    await waitFor(() => {
      expect(messageMock).toHaveBeenCalledWith(
        "Delete this project's worktrees before removing it from Skein.",
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
      screen.getAllByRole("button", { name: /Skein/i })[0],
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove from Skein" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Disk is unavailable.")).toBeInTheDocument();
    });
  });

  it.skip("shows a destructive confirmation before deleting a worktree", async () => {
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
                path: "/Users/test/.skein/worktrees/skein/fuzzy-tiger",
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

  it("keeps empty worktrees visible and routes their branch menu through the placeholder row", () => {
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
                threads: [],
              }),
              makeEnvironment({
                id: "env-worktree",
                kind: "managedWorktree",
                name: "add-themes",
                gitBranch: "add-themes",
                path: "/Users/test/.skein/worktrees/skein/add-themes",
                pullRequest: {
                  number: 17,
                  title: "Add themes",
                  url: "https://github.com/acme/skein/pull/17",
                  state: "open",
                },
                threads: [
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

    const placeholder = screen.getByRole("button", {
      name: "Start thread in add-themes",
    });
    expect(placeholder).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open PR #17: Add themes" }),
    ).toBeInTheDocument();

    fireEvent.contextMenu(placeholder);

    expect(
      screen.getByRole("button", { name: "New thread in add-themes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open pull request" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete worktree" }),
    ).toBeInTheDocument();
  });

  it("anchors the branch menu to the trigger button for keyboard activation", () => {
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
                name: "say-hello",
                gitBranch: "say-hello",
                threads: [
                  makeThread({
                    id: "thread-worktree",
                    title: "Say Hello",
                    environmentId: "env-worktree",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    }));

    renderSidebar();

    const branchButton = screen.getByRole("button", { name: "Worktree: say-hello" });
    vi.spyOn(branchButton, "getBoundingClientRect").mockReturnValue({
      x: 40,
      y: 96,
      top: 96,
      left: 40,
      width: 96,
      height: 20,
      right: 136,
      bottom: 116,
      toJSON: vi.fn(),
    });

    fireEvent.contextMenu(branchButton);

    const menu = document.body.querySelector(".tree-sidebar__context-menu");
    expect(menu).not.toBeNull();
    expect(menu).toHaveStyle({ left: "40px", top: "120px" });
  });

  it("marks worktree threads so the branch badge stays inside the thread capsule", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [makeProjectWithLocalAndWorktree()],
      }),
    }));

    renderSidebar();

    expect(
      screen.getByRole("button", { name: "Worktree thread" }),
    ).toHaveClass("tree-sidebar__thread--with-worktree");
  });

  it("sorts flattened worktree threads globally by most recent activity", () => {
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
                threads: [],
              }),
              makeEnvironment({
                id: "env-worktree-older",
                kind: "managedWorktree",
                name: "older-branch",
                gitBranch: "older-branch",
                threads: [
                  makeThread({
                    id: "thread-older",
                    environmentId: "env-worktree-older",
                    title: "Older task",
                    updatedAt: "2026-04-03T08:00:00Z",
                  }),
                ],
              }),
              makeEnvironment({
                id: "env-worktree-newer",
                kind: "managedWorktree",
                name: "newer-branch",
                gitBranch: "newer-branch",
                threads: [
                  makeThread({
                    id: "thread-newer",
                    environmentId: "env-worktree-newer",
                    title: "Newer task",
                    updatedAt: "2026-04-03T09:00:00Z",
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
      textContentList(container.querySelectorAll(".tree-sidebar__thread-title")),
    ).toEqual(["Newer task", "Older task"]);
  });

  it.skip("shows a waiting indicator on a worktree when any active thread awaits action", () => {
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

  it.skip("keeps stopped worktrees with persisted chat history neutral until hydrated", () => {
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
      row.querySelector(".runtime-indicator__dot--neutral"),
    ).not.toBeNull();
  });

  it.skip("shows neutral indicators when local and worktree environments have no active threads", () => {
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

  it("opens the worktree pull request on left-click when a PR is open", async () => {
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
                  url: "https://github.com/acme/skein/pull/17",
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
        name: "Open PR #17: Add themes",
      }),
    );

    expect(openUrlMock).toHaveBeenCalledWith(
      "https://github.com/acme/skein/pull/17",
    );
    expect(useWorkspaceStore.getState().selectedEnvironmentId).toBe(
      "env-local",
    );
  });

  it.each([
    { state: "open" as const, badgeLabel: "Open PR #17: Add themes" },
    { state: "merged" as const, badgeLabel: "Merged PR #17: Add themes" },
    { state: "closed" as const, badgeLabel: "Closed PR #17: Add themes" },
  ])(
    "opens the worktree context menu on right-click for $state PR",
    ({ state, badgeLabel }) => {
      useWorkspaceStore.setState((workspace) => ({
        ...workspace,
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
                    url: "https://github.com/acme/skein/pull/17",
                    state,
                  },
                }),
              ],
            }),
          ],
        }),
      }));

      renderSidebar();

      fireEvent.contextMenu(
        screen.getByRole("button", { name: badgeLabel }),
      );

      expect(
        screen.getByRole("button", { name: "Delete worktree" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Open pull request" }),
      ).toBeInTheDocument();
    },
  );

  it("opens the worktree context menu on right-click when no PR exists", () => {
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
              }),
            ],
          }),
        ],
      }),
    }));

    renderSidebar();

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Worktree: add-themes" }),
    );

    expect(
      screen.getByRole("button", { name: "Delete worktree" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open pull request" }),
    ).toBeNull();
  });

  it("renders merged pull request with a merged aria-label and merged data state", () => {
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
                  url: "https://github.com/acme/skein/pull/29",
                  state: "merged",
                },
              }),
            ],
          }),
        ],
      }),
    }));

    renderSidebar();

    const badge = screen.getByRole("button", {
      name: "Merged PR #29: Release cut",
    });
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute("data-pr-state")).toBe("merged");
  });

  it("renders closed pull request with the closed aria-label and red data state", async () => {
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
                name: "abandoned",
                gitBranch: "abandoned",
                pullRequest: {
                  number: 42,
                  title: "Abandoned attempt",
                  url: "https://github.com/acme/skein/pull/42",
                  state: "closed",
                },
              }),
            ],
          }),
        ],
      }),
    }));

    renderSidebar();

    const badge = screen.getByRole("button", {
      name: "Closed PR #42: Abandoned attempt",
    });
    expect(badge.getAttribute("data-pr-state")).toBe("closed");

    await userEvent.click(badge);

    expect(openUrlMock).toHaveBeenCalledWith(
      "https://github.com/acme/skein/pull/42",
    );
  });

  it("does nothing on left-click when no pull request exists", async () => {
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
                name: "no-pr",
                gitBranch: "no-pr",
              }),
            ],
          }),
        ],
      }),
    }));

    renderSidebar();

    const badge = screen.getByRole("button", {
      name: "Worktree: no-pr",
    });
    expect(badge.getAttribute("data-pr-state")).toBe("none");

    await userEvent.click(badge);

    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it("persists project collapse from the dedicated chevron", async () => {
    const collapsedSnapshot = makeWorkspaceSnapshot({
      projects: [
        makeProject({
          sidebarCollapsed: true,
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
            }),
          ],
        }),
      ],
    });
    const refreshSnapshot = vi.fn(async () => {
      useWorkspaceStore.setState((state) => ({
        ...state,
        snapshot: collapsedSnapshot,
      }));
      return true;
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
              }),
              makeEnvironment({
                id: "env-worktree",
                kind: "managedWorktree",
                name: "fuzzy-tiger",
                gitBranch: "fuzzy-tiger",
              }),
            ],
          }),
        ],
      }),
      refreshSnapshot,
    }));

    renderSidebar();

    expect(
      screen.getByRole("button", { name: "Worktree: fuzzy-tiger" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Collapse Skein" }));

    expect(mockedBridge.setProjectSidebarCollapsed).toHaveBeenCalledWith({
      projectId: "project-1",
      collapsed: true,
    });
    await waitFor(() => {
      expect(refreshSnapshot).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Worktree: fuzzy-tiger" })).toBeNull();
    });
    expect(mockedBridge.reorderProjects).not.toHaveBeenCalled();
  });

  it("persists project collapse from the clickable project row", async () => {
    const collapsedSnapshot = makeWorkspaceSnapshot({
      projects: [
        makeProject({
          sidebarCollapsed: true,
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
            }),
          ],
        }),
      ],
    });
    const refreshSnapshot = vi.fn(async () => {
      useWorkspaceStore.setState((state) => ({
        ...state,
        snapshot: collapsedSnapshot,
      }));
      return true;
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
              }),
              makeEnvironment({
                id: "env-worktree",
                kind: "managedWorktree",
                name: "fuzzy-tiger",
                gitBranch: "fuzzy-tiger",
              }),
            ],
          }),
        ],
      }),
      refreshSnapshot,
    }));

    const { container } = renderSidebar();

    expect(
      screen.getByRole("button", { name: "Worktree: fuzzy-tiger" }),
    ).toBeInTheDocument();

    await userEvent.click(
      container.querySelector<HTMLElement>(".project-group__header-shell")!,
    );

    expect(mockedBridge.setProjectSidebarCollapsed).toHaveBeenCalledWith({
      projectId: "project-1",
      collapsed: true,
    });
    await waitFor(() => {
      expect(refreshSnapshot).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Worktree: fuzzy-tiger" })).toBeNull();
    });
    expect(mockedBridge.reorderProjects).not.toHaveBeenCalled();
  });

  it("collapses the current project on a simple project click", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [makeProjectWithLocalAndWorktree()],
      }),
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-worktree",
      selectedThreadId: "thread-worktree",
    }));

    const { container } = renderSidebar();
    const projectHeaders = container.querySelectorAll<HTMLElement>(
      ".project-group__header-shell",
    );

    await userEvent.click(projectHeaders[0]);

    expect(mockedBridge.setProjectSidebarCollapsed).toHaveBeenCalledWith({
      projectId: "project-1",
      collapsed: true,
    });
    expect(mockedBridge.reorderProjects).not.toHaveBeenCalled();
  });

  it("does not collapse the project after a drag gesture", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [makeProjectWithLocalAndWorktree()],
      }),
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-worktree",
      selectedThreadId: "thread-worktree",
    }));

    const { container } = renderSidebar();
    const projectHeader = container.querySelector<HTMLElement>(
      ".project-group__header-shell",
    );

    expect(projectHeader).not.toBeNull();

    fireEvent.pointerDown(projectHeader as HTMLElement, {
      button: 0,
      buttons: 1,
      clientX: 12,
      clientY: 16,
      isPrimary: true,
      pointerId: 30,
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 28,
      clientY: 32,
      isPrimary: true,
      pointerId: 30,
    });
    fireEvent.pointerUp(window, {
      clientX: 28,
      clientY: 32,
      isPrimary: true,
      pointerId: 30,
    });
    fireEvent.click(projectHeader as HTMLElement);

    expect(mockedBridge.setProjectSidebarCollapsed).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().selectedEnvironmentId).toBe(
      "env-worktree",
    );
    expect(useWorkspaceStore.getState().selectedThreadId).toBe("thread-worktree");
    expect(mockedBridge.reorderProjects).not.toHaveBeenCalled();
  });

  it("does not collapse the project when opening the project menu", async () => {
    renderSidebar();

    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Skein" }),
    );

    expect(
      screen.getByRole("button", { name: "Remove from Skein" }),
    ).toBeInTheDocument();
    expect(mockedBridge.setProjectSidebarCollapsed).not.toHaveBeenCalled();
  });

  it("does not collapse the project when creating a new thread from the project row", async () => {
    renderSidebar();

    await userEvent.click(
      screen.getByRole("button", { name: "New thread in Skein" }),
    );

    expect(mockedBridge.setProjectSidebarCollapsed).not.toHaveBeenCalled();
  });

  it("toggles project collapse from the project button with Enter and Space", async () => {
    const { container } = renderSidebar();
    const getProjectHeader = () =>
      container.querySelector<HTMLButtonElement>(".project-group__header");
    const getChevronButton = () =>
      container.querySelector<HTMLButtonElement>(".project-group__collapse");

    expect(getProjectHeader()).not.toBeNull();

    getProjectHeader()!.focus();
    fireEvent.keyDown(getProjectHeader()!, { key: "Enter" });

    expect(mockedBridge.setProjectSidebarCollapsed).toHaveBeenCalledWith({
      projectId: "project-1",
      collapsed: true,
    });
    await waitFor(() => {
      expect(getProjectHeader()).toHaveAttribute("aria-expanded", "false");
      expect(getChevronButton()).toHaveAttribute("aria-label", "Expand Skein");
    });

    mockedBridge.setProjectSidebarCollapsed.mockClear();

    getProjectHeader()!.focus();
    fireEvent.keyDown(getProjectHeader()!, { key: " " });

    expect(mockedBridge.setProjectSidebarCollapsed).toHaveBeenCalledWith({
      projectId: "project-1",
      collapsed: false,
    });
    await waitFor(() => {
      expect(getProjectHeader()).toHaveAttribute("aria-expanded", "true");
      expect(getChevronButton()).toHaveAttribute("aria-label", "Collapse Skein");
    });
  });

  it("reorders projects in preview before persisting the drop", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            id: "project-a",
            name: "First",
            environments: [
              makeEnvironment({
                id: "env-a",
                projectId: "project-a",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
          makeProject({
            id: "project-b",
            name: "Second",
            environments: [
              makeEnvironment({
                id: "env-b",
                projectId: "project-b",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
        ],
      }),
    }));
    const { container } = renderSidebar();
    const projectGroups =
      container.querySelectorAll<HTMLElement>(".project-group");
    const projectHeaders = container.querySelectorAll<HTMLElement>(
      ".project-group__header-shell",
    );
    stubVerticalRects(Array.from(projectGroups), { height: 40, gap: 10 });

    fireEvent.pointerDown(projectHeaders[1], {
      button: 0,
      buttons: 1,
      clientX: 12,
      clientY: 56,
      isPrimary: true,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 1,
    });

    await waitFor(() => {
      expect(
        textContentList(container.querySelectorAll(".project-group__name")),
      ).toEqual(["Second", "First"]);
    });
    expect(projectGroups[1].style.transform).toContain("translate3d(");
    expect(mockedBridge.reorderProjects).not.toHaveBeenCalled();

    fireEvent.pointerUp(window, {
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 1,
    });

    await waitFor(() => {
      expect(mockedBridge.reorderProjects).toHaveBeenCalledWith({
        projectIds: ["project-b", "project-a"],
      });
    });
  });

  it("persists project reorder even when dropped immediately after preview", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            id: "project-a",
            name: "First",
            environments: [
              makeEnvironment({
                id: "env-a",
                projectId: "project-a",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
          makeProject({
            id: "project-b",
            name: "Second",
            environments: [
              makeEnvironment({
                id: "env-b",
                projectId: "project-b",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
        ],
      }),
    }));
    const { container } = renderSidebar();
    const projectGroups =
      container.querySelectorAll<HTMLElement>(".project-group");
    const projectHeaders = container.querySelectorAll<HTMLElement>(
      ".project-group__header-shell",
    );
    const projectList = container.querySelector<HTMLElement>(
      ".tree-sidebar__project-list",
    );
    stubVerticalRects(Array.from(projectGroups), { height: 40, gap: 10 });

    expect(projectList).not.toBeNull();

    fireEvent.pointerDown(projectHeaders[1], {
      button: 0,
      buttons: 1,
      clientX: 12,
      clientY: 56,
      isPrimary: true,
      pointerId: 2,
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 2,
    });
    fireEvent.pointerUp(window, {
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 2,
    });

    await waitFor(() => {
      expect(mockedBridge.reorderProjects).toHaveBeenCalledWith({
        projectIds: ["project-b", "project-a"],
      });
    });
  });

  it("suppresses the follow-up click after a real project drag", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            id: "project-a",
            name: "First",
            environments: [
              makeEnvironment({
                id: "env-a",
                projectId: "project-a",
                kind: "local",
                isDefault: true,
                threads: [
                  makeThread({
                    id: "thread-a",
                    environmentId: "env-a",
                  }),
                ],
              }),
            ],
          }),
          makeProject({
            id: "project-b",
            name: "Second",
            environments: [
              makeEnvironment({
                id: "env-b",
                projectId: "project-b",
                kind: "local",
                isDefault: true,
                threads: [
                  makeThread({
                    id: "thread-b",
                    environmentId: "env-b",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      selectedProjectId: "project-a",
      selectedEnvironmentId: "env-a",
      selectedThreadId: "thread-a",
    }));

    const { container } = renderSidebar();
    const projectGroups = () =>
      Array.from(container.querySelectorAll<HTMLElement>(".project-group"));
    const projectHeaders = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(".project-group__header-shell"),
      );
    stubVerticalRects(projectGroups(), { height: 40, gap: 10 });

    fireEvent.pointerDown(projectHeaders()[1], {
      button: 0,
      buttons: 1,
      clientX: 12,
      clientY: 56,
      isPrimary: true,
      pointerId: 31,
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 31,
    });

    await waitFor(() => {
      expect(
        textContentList(container.querySelectorAll(".project-group__name")),
      ).toEqual(["Second", "First"]);
    });

    fireEvent.pointerUp(window, {
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 31,
    });
    fireEvent.click(projectHeaders()[0], { detail: 1 });

    expect(useWorkspaceStore.getState().selectedProjectId).toBe("project-a");
    expect(useWorkspaceStore.getState().selectedEnvironmentId).toBe("env-a");
    expect(useWorkspaceStore.getState().selectedThreadId).toBe("thread-a");

    await waitFor(() => {
      expect(mockedBridge.reorderProjects).toHaveBeenCalledWith({
        projectIds: ["project-b", "project-a"],
      });
    });
  });

  it("keeps reordered project clicks inert after suppressing a drag click", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            id: "project-a",
            name: "First",
            environments: [
              makeEnvironment({
                id: "env-a",
                projectId: "project-a",
                kind: "local",
                isDefault: true,
                threads: [
                  makeThread({
                    id: "thread-a",
                    environmentId: "env-a",
                  }),
                ],
              }),
            ],
          }),
          makeProject({
            id: "project-b",
            name: "Second",
            environments: [
              makeEnvironment({
                id: "env-b",
                projectId: "project-b",
                kind: "local",
                isDefault: true,
                threads: [
                  makeThread({
                    id: "thread-b",
                    environmentId: "env-b",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      selectedProjectId: "project-a",
      selectedEnvironmentId: "env-a",
      selectedThreadId: "thread-a",
    }));

    const { container } = renderSidebar();
    const projectGroups = () =>
      Array.from(container.querySelectorAll<HTMLElement>(".project-group"));
    const projectHeaders = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(".project-group__header-shell"),
      );
    stubVerticalRects(projectGroups(), { height: 40, gap: 10 });

    fireEvent.pointerDown(projectHeaders()[1], {
      button: 0,
      buttons: 1,
      clientX: 12,
      clientY: 56,
      isPrimary: true,
      pointerId: 32,
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 32,
    });

    await waitFor(() => {
      expect(
        textContentList(container.querySelectorAll(".project-group__name")),
      ).toEqual(["Second", "First"]);
    });

    fireEvent.pointerUp(window, {
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 32,
    });
    fireEvent.click(projectHeaders()[0], { detail: 1 });

    expect(useWorkspaceStore.getState().selectedProjectId).toBe("project-a");
    expect(useWorkspaceStore.getState().selectedEnvironmentId).toBe("env-a");
    expect(useWorkspaceStore.getState().selectedThreadId).toBe("thread-a");

    await waitFor(() => {
      expect(mockedBridge.reorderProjects).toHaveBeenCalledWith({
        projectIds: ["project-b", "project-a"],
      });
    });
  });

  it("clears project drag visuals immediately on drop", async () => {
    const persist = createDeferred();
    mockedBridge.reorderProjects.mockImplementationOnce(() => persist.promise);
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            id: "project-a",
            name: "First",
            environments: [
              makeEnvironment({
                id: "env-a",
                projectId: "project-a",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
          makeProject({
            id: "project-b",
            name: "Second",
            environments: [
              makeEnvironment({
                id: "env-b",
                projectId: "project-b",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
        ],
      }),
    }));

    const { container } = renderSidebar();
    const projectGroups =
      container.querySelectorAll<HTMLElement>(".project-group");
    const projectHeaders = container.querySelectorAll<HTMLElement>(
      ".project-group__header-shell",
    );
    stubVerticalRects(Array.from(projectGroups), { height: 40, gap: 10 });

    fireEvent.pointerDown(projectHeaders[1], {
      button: 0,
      buttons: 1,
      clientX: 12,
      clientY: 56,
      isPrimary: true,
      pointerId: 20,
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 20,
    });

    await waitFor(() => {
      expect(
        textContentList(container.querySelectorAll(".project-group__name")),
      ).toEqual(["Second", "First"]);
    });

    fireEvent.pointerUp(window, {
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 20,
    });

    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>(".project-group"),
        (group) => group.style.transform,
      ),
    ).toEqual(["", ""]);

    persist.resolve();
    await waitFor(() => {
      expect(mockedBridge.reorderProjects).toHaveBeenCalledWith({
        projectIds: ["project-b", "project-a"],
      });
    });
  });

  it("keeps a newer project drag preview while an earlier reorder persists", async () => {
    const firstPersist = createDeferred();
    const secondPersist = createDeferred();
    mockedBridge.reorderProjects
      .mockImplementationOnce(() => firstPersist.promise)
      .mockImplementationOnce(() => secondPersist.promise);
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            id: "project-a",
            name: "First",
            environments: [
              makeEnvironment({
                id: "env-a",
                projectId: "project-a",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
          makeProject({
            id: "project-b",
            name: "Second",
            environments: [
              makeEnvironment({
                id: "env-b",
                projectId: "project-b",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
          makeProject({
            id: "project-c",
            name: "Third",
            environments: [
              makeEnvironment({
                id: "env-c",
                projectId: "project-c",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
        ],
      }),
    }));

    const { container } = renderSidebar();
    const projectGroups = () =>
      Array.from(container.querySelectorAll<HTMLElement>(".project-group"));
    const projectHeaders = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(".project-group__header-shell"),
      );
    stubVerticalRects(projectGroups(), { height: 40, gap: 10 });

    fireEvent.pointerDown(projectHeaders()[2], {
      button: 0,
      buttons: 1,
      clientX: 12,
      clientY: 106,
      isPrimary: true,
      pointerId: 21,
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 21,
    });

    await waitFor(() => {
      expect(
        textContentList(container.querySelectorAll(".project-group__name")),
      ).toEqual(["Third", "First", "Second"]);
    });

    fireEvent.pointerUp(window, {
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 21,
    });

    stubVerticalRects(projectGroups(), { height: 40, gap: 10 });
    fireEvent.pointerDown(projectHeaders()[2], {
      button: 0,
      buttons: 1,
      clientX: 12,
      clientY: 106,
      isPrimary: true,
      pointerId: 22,
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 22,
    });

    await waitFor(() => {
      expect(
        textContentList(container.querySelectorAll(".project-group__name")),
      ).toEqual(["Second", "Third", "First"]);
    });

    firstPersist.resolve();

    await waitFor(() => {
      expect(
        textContentList(container.querySelectorAll(".project-group__name")),
      ).toEqual(["Second", "Third", "First"]);
    });

    fireEvent.pointerUp(window, {
      clientX: 12,
      clientY: 8,
      isPrimary: true,
      pointerId: 22,
    });

    secondPersist.resolve();

    await waitFor(() => {
      expect(mockedBridge.reorderProjects).toHaveBeenNthCalledWith(2, {
        projectIds: ["project-b", "project-c", "project-a"],
      });
    });
  });

  it("reorders projects from the project row keyboard fallback", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            id: "project-a",
            name: "First",
            environments: [
              makeEnvironment({
                id: "env-a",
                projectId: "project-a",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
          makeProject({
            id: "project-b",
            name: "Second",
            environments: [
              makeEnvironment({
                id: "env-b",
                projectId: "project-b",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
        ],
      }),
    }));

    const { container } = renderSidebar();

    const projectRows =
      container.querySelectorAll<HTMLButtonElement>(".project-group__header");
    fireEvent.keyDown(projectRows[1], {
      key: "ArrowUp",
    });

    await waitFor(() => {
      expect(mockedBridge.reorderProjects).toHaveBeenCalledWith({
        projectIds: ["project-b", "project-a"],
      });
    });
  });

  it("reorders projects to the first position with Home from the project row", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            id: "project-a",
            name: "First",
            environments: [
              makeEnvironment({
                id: "env-a",
                projectId: "project-a",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
          makeProject({
            id: "project-b",
            name: "Second",
            environments: [
              makeEnvironment({
                id: "env-b",
                projectId: "project-b",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
          makeProject({
            id: "project-c",
            name: "Third",
            environments: [
              makeEnvironment({
                id: "env-c",
                projectId: "project-c",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
        ],
      }),
    }));

    const { container } = renderSidebar();

    const projectRows =
      container.querySelectorAll<HTMLButtonElement>(".project-group__header");
    fireEvent.keyDown(projectRows[2], {
      key: "Home",
    });

    await waitFor(() => {
      expect(mockedBridge.reorderProjects).toHaveBeenCalledWith({
        projectIds: ["project-c", "project-a", "project-b"],
      });
    });
  });

  it("reorders projects to the last position with End from the project row", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            id: "project-a",
            name: "First",
            environments: [
              makeEnvironment({
                id: "env-a",
                projectId: "project-a",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
          makeProject({
            id: "project-b",
            name: "Second",
            environments: [
              makeEnvironment({
                id: "env-b",
                projectId: "project-b",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
          makeProject({
            id: "project-c",
            name: "Third",
            environments: [
              makeEnvironment({
                id: "env-c",
                projectId: "project-c",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
        ],
      }),
    }));

    const { container } = renderSidebar();

    const projectRows =
      container.querySelectorAll<HTMLButtonElement>(".project-group__header");
    fireEvent.keyDown(projectRows[0], {
      key: "End",
    });

    await waitFor(() => {
      expect(mockedBridge.reorderProjects).toHaveBeenCalledWith({
        projectIds: ["project-b", "project-c", "project-a"],
      });
    });
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
        projectName: "Skein",
        worktreeId: "env-worktree",
        worktreeName: "fuzzy-tiger",
        worktreeBranch: "fuzzy-tiger",
        worktreePath: "/tmp/fuzzy-tiger",
        message: 'Teardown script failed for "fuzzy-tiger" (exit code 1).',
        logPath: "/tmp/skein-script.log",
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
    expect(screen.getByText("/tmp/skein-script.log")).toBeInTheDocument();
  });
});
