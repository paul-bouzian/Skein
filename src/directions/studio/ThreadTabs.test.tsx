import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import { makeEnvironment, makeWorkspaceSnapshot } from "../../test/fixtures/conversation";
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
    refreshSnapshot: vi.fn(async () => {}),
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
    const refreshSnapshot = vi.fn(async () => {});
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
});
