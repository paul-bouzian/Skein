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

vi.mock("../../lib/bridge", () => ({
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
}));

const mockedBridge = vi.mocked(bridge);
const onOpenSettings = vi.fn();
const onToggleTheme = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
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
              path: "/Users/test/.threadex/worktrees/threadex-12345678/fuzzy-tiger",
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
      screen.getByRole("button", { name: "Create worktree for ThreadEx" }),
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
                path: "/Users/test/.threadex/worktrees/threadex-12345678/fuzzy-tiger",
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

  it("shows a waiting indicator on a worktree when the latest snapshot awaits action", () => {
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
                    id: "thread-worktree",
                    environmentId: "env-worktree",
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
        "thread-worktree": makeConversationSnapshot({
          threadId: "thread-worktree",
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
        projectName: "ThreadEx",
        worktreeId: "env-worktree",
        worktreeName: "fuzzy-tiger",
        worktreeBranch: "fuzzy-tiger",
        worktreePath: "/tmp/fuzzy-tiger",
        message: 'Teardown script failed for "fuzzy-tiger" (exit code 1).',
        logPath: "/tmp/threadex-script.log",
        exitCode: 1,
      },
      listenerReady: true,
    });

    renderSidebar();

    expect(
      screen.getByText("Teardown script failed for fuzzy-tiger"),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Teardown script failed for "fuzzy-tiger" (exit code 1).'),
    ).toBeInTheDocument();
    expect(screen.getByText("/tmp/threadex-script.log")).toBeInTheDocument();
  });
});
