import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import {
  makeConversationSnapshot,
  makeEnvironment,
  makeProject,
  makeTaskPlan,
  makeThread,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { useConversationStore } from "../../stores/conversation-store";
import {
  resetVoiceSessionStore,
  useVoiceSessionStore,
} from "../../stores/voice-session-store";
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

function expectThreadIndicator(title: string, tone: string) {
  const threadButton = screen.getByRole("button", { name: title });
  expect(
    threadButton.querySelector(`.runtime-indicator__dot--${tone}`),
  ).not.toBeNull();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetVoiceSessionStore();
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

  it("prevents archiving the thread that still owns voice work", async () => {
    useVoiceSessionStore.setState((state) => ({
      ...state,
      ownerEnvironmentId: "env-1",
      ownerThreadId: "thread-1",
      phase: "recording",
    }));

    render(<ThreadTabs />);

    const archiveButton = screen.getByRole("button", {
      name: "Archive Thread 1",
    });
    expect(archiveButton).toBeDisabled();
    expect(archiveButton).toHaveAttribute(
      "title",
      "Finish handling voice dictation in Thread 1 before archiving it.",
    );

    await userEvent.click(archiveButton);

    expect(confirmMock).not.toHaveBeenCalled();
    expect(mockedBridge.archiveThread).not.toHaveBeenCalled();
  });

  it("renders a neutral indicator before a thread snapshot is loaded", () => {
    render(<ThreadTabs />);

    expectThreadIndicator("Thread 1", "neutral");
  });

  it("renders per-thread indicators from canonical conversation status", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [
              makeEnvironment({
                id: "env-1",
                threads: [
                  makeThread({ id: "thread-idle", title: "Idle thread" }),
                  makeThread({ id: "thread-running", title: "Running thread" }),
                  makeThread({
                    id: "thread-completed",
                    title: "Completed thread",
                  }),
                  makeThread({ id: "thread-failed", title: "Failed thread" }),
                  makeThread({ id: "thread-waiting", title: "Waiting thread" }),
                ],
              }),
            ],
          }),
        ],
      }),
      selectedThreadId: "thread-idle",
    }));
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: {
        "thread-idle": makeConversationSnapshot({
          threadId: "thread-idle",
          status: "idle",
        }),
        "thread-running": makeConversationSnapshot({
          threadId: "thread-running",
          status: "running",
        }),
        "thread-completed": makeConversationSnapshot({
          threadId: "thread-completed",
          status: "completed",
        }),
        "thread-failed": makeConversationSnapshot({
          threadId: "thread-failed",
          status: "failed",
        }),
        "thread-waiting": makeConversationSnapshot({
          threadId: "thread-waiting",
          status: "waitingForExternalAction",
        }),
      },
    }));

    render(<ThreadTabs />);

    expectThreadIndicator("Idle thread", "neutral");
    expectThreadIndicator("Running thread", "progress");
    expectThreadIndicator("Completed thread", "completed");
    expectThreadIndicator("Failed thread", "failed");
    expectThreadIndicator("Waiting thread", "waiting");
  });

  it("keeps completed task trackers on the completed indicator path", () => {
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: {
        "thread-1": makeConversationSnapshot({
          status: "completed",
          taskPlan: makeTaskPlan({ status: "completed" }),
        }),
      },
    }));

    render(<ThreadTabs />);

    expectThreadIndicator("Thread 1", "completed");
  });

  it("logs create-thread failures instead of leaking a rejected click handler", async () => {
    const error = new Error("create failed");
    mockedBridge.createThread.mockRejectedValue(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      render(<ThreadTabs />);

      await userEvent.click(screen.getByTitle("New thread"));

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith("Failed to create a thread:", error);
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("logs archive failures instead of leaking a rejected click handler", async () => {
    const error = new Error("archive failed");
    confirmMock.mockResolvedValue(true);
    mockedBridge.archiveThread.mockRejectedValue(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      render(<ThreadTabs />);

      await userEvent.click(screen.getByRole("button", { name: "Archive Thread 1" }));

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith("Failed to archive Thread 1:", error);
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});
