import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import {
  makeEnvironment,
  makeThread,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { useWorkspaceStore } from "../../stores/workspace-store";
import {
  archiveThreadWithConfirmation,
  selectAdjacentThread,
} from "./studioActions";

const confirmMock = vi.fn();

vi.mock("../../lib/bridge", () => ({
  archiveThread: vi.fn(),
  createManagedWorktree: vi.fn(),
  createThread: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
}));

const mockedBridge = vi.mocked(bridge);

describe("studioActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmMock.mockReset();
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          {
            ...makeWorkspaceSnapshot().projects[0]!,
            environments: [
              makeEnvironment({
                threads: [
                  makeThread({ id: "thread-1", title: "Thread 1" }),
                  makeThread({ id: "thread-2", title: "Thread 2" }),
                ],
              }),
            ],
          },
        ],
      }),
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
      selectedThreadId: null,
      selectThread: vi.fn((threadId: string | null) =>
        useWorkspaceStore.setState((current) => ({ ...current, selectedThreadId: threadId })),
      ),
    }));
  });

  it("selects the first active thread when navigating next with no current selection", () => {
    expect(selectAdjacentThread("next")).toBe(true);
    expect(useWorkspaceStore.getState().selectedThreadId).toBe("thread-1");
  });

  it("preserves a newer thread selection made while the archive confirmation is open", async () => {
    let resolveConfirm!: (value: boolean) => void;
    confirmMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    mockedBridge.archiveThread.mockResolvedValue(makeThread({ id: "thread-1" }));

    const archivePromise = archiveThreadWithConfirmation("thread-1");
    useWorkspaceStore.getState().selectThread("thread-2");
    resolveConfirm(true);

    await archivePromise;

    expect(useWorkspaceStore.getState().selectedThreadId).toBe("thread-2");
    expect(mockedBridge.archiveThread).toHaveBeenCalledWith({ threadId: "thread-1" });
  });
});
