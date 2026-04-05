import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import {
  makeConversationSnapshot,
  makeEnvironment,
  makeTaskPlan,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { useConversationStore } from "../../stores/conversation-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { ThreadTabs } from "./ThreadTabs";

const confirmMock = vi.fn();

vi.mock("../../lib/bridge", () => ({
  createThread: vi.fn(),
  archiveThread: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
}));

const mockedBridge = vi.mocked(bridge);

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: makeWorkspaceSnapshot(),
    loadingState: "ready",
    selectedProjectId: "project-1",
    selectedEnvironmentId: "env-1",
    selectedThreadId: "thread-1",
    refreshSnapshot: vi.fn(async () => true),
  }));
  useConversationStore.setState((state) => ({
    ...state,
    snapshotsByThreadId: {},
  }));
});

describe("ThreadTabs", () => {
  it("confirms before archiving a thread", async () => {
    confirmMock.mockResolvedValue(false);
    render(<ThreadTabs />);

    await userEvent.click(screen.getByRole("button", { name: "Archive Thread 1" }));

    expect(confirmMock).toHaveBeenCalledWith(
      "Are you sure you want to archive this thread?",
      expect.objectContaining({
        title: "Archive Thread",
        okLabel: "Archive",
      }),
    );
    expect(mockedBridge.archiveThread).not.toHaveBeenCalled();
  });

  it("archives the thread after confirmation", async () => {
    confirmMock.mockResolvedValue(true);
    mockedBridge.archiveThread.mockResolvedValue(makeEnvironment().threads[0]);
    const refreshSnapshot = vi.fn(async () => true);
    useWorkspaceStore.setState((state) => ({
      ...state,
      refreshSnapshot,
    }));

    render(<ThreadTabs />);

    await userEvent.click(screen.getByRole("button", { name: "Archive Thread 1" }));

    await waitFor(() => {
      expect(mockedBridge.archiveThread).toHaveBeenCalledWith({ threadId: "thread-1" });
    });
    expect(refreshSnapshot).toHaveBeenCalled();
  });

  it("does not mark a thread as needing attention for a completed task tracker", () => {
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: {
        "thread-1": makeConversationSnapshot({
          taskPlan: makeTaskPlan({ status: "completed" }),
        }),
      },
    }));

    const { container } = render(<ThreadTabs />);

    expect(container.querySelector(".thread-tab__status-dot")).toBeNull();
  });
});
