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

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
}));

const mockedBridge = vi.mocked(bridge);

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
    refreshSnapshot: vi.fn(async () => {}),
  }));
});

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
              threads: [makeThread({ id: "thread-local", environmentId: "env-local" })],
            }),
            makeEnvironment({
              id: "env-worktree-new",
              kind: "managedWorktree",
              isDefault: false,
              name: "fuzzy-tiger",
              gitBranch: "fuzzy-tiger",
              path: "/Users/test/.threadex/worktrees/threadex-12345678/fuzzy-tiger",
              threads: [makeThread({ id: "thread-worktree-new", environmentId: "env-worktree-new" })],
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
    });
    useWorkspaceStore.setState((state) => ({
      ...state,
      refreshSnapshot,
    }));
    mockedBridge.createManagedWorktree.mockResolvedValue({
      environment: updatedSnapshot.projects[0].environments[1],
      thread: updatedSnapshot.projects[0].environments[1].threads[0],
    });

    render(<TreeSidebar activeSection="projects" />);

    await userEvent.click(screen.getByRole("button", { name: "Create worktree for ThreadEx" }));

    await waitFor(() => {
      expect(mockedBridge.createManagedWorktree).toHaveBeenCalledWith("project-1");
    });
    expect(refreshSnapshot).toHaveBeenCalled();
    expect(useWorkspaceStore.getState().selectedThreadId).toBe("thread-worktree-new");
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
                  makeThread({ id: "thread-active", environmentId: "env-worktree", status: "active" }),
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

    render(<TreeSidebar activeSection="projects" />);

    fireEvent.contextMenu(screen.getByRole("button", { name: /fuzzy-tiger/i }));
    await userEvent.click(screen.getByRole("button", { name: "Delete worktree" }));

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
                threads: [makeThread({ id: "thread-worktree", environmentId: "env-worktree" })],
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

    render(<TreeSidebar activeSection="projects" />);

    const row = screen.getByRole("button", { name: /slate-hawk/i });
    expect(row.querySelector(".runtime-indicator__dot--waiting")).not.toBeNull();
  });
});
