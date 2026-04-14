import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import {
  makeEnvironment,
  makeProject,
  makeThread,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { useVoiceSessionStore } from "../../stores/voice-session-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import {
  archiveThreadWithConfirmation,
  createManagedWorktreeForSelection,
  createThreadForSelection,
  selectAdjacentEnvironment,
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
    useVoiceSessionStore.setState({
      activeSessionToken: null,
      durationMs: 0,
      ownerEnvironmentId: null,
      ownerThreadId: null,
      pendingOutcomesByThreadId: {},
      phase: "idle",
      recordingStartedAt: null,
    });
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
      layout: {
        slots: {
          topLeft: {
            projectId: "project-1",
            environmentId: "env-1",
            threadId: null,
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
      selectedThreadId: null,
    }));
  });

  it("selects the first active thread when navigating next with no current selection", () => {
    expect(selectAdjacentThread("next")).toBe(true);
    expect(useWorkspaceStore.getState().selectedThreadId).toBe("thread-1");
  });

  it("does not select a newly created thread when the snapshot refresh fails", async () => {
    mockedBridge.createThread.mockResolvedValue(makeThread({ id: "thread-3" }));
    const refreshSnapshot = vi.fn(async () => false);
    useWorkspaceStore.setState((state) => ({ ...state, refreshSnapshot }));
    useWorkspaceStore.getState().selectThread("thread-1");

    await expect(createThreadForSelection()).resolves.toBe(false);

    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().selectedThreadId).toBe("thread-1");
  });

  it("does not select a managed-worktree thread when the snapshot refresh fails", async () => {
    mockedBridge.createManagedWorktree.mockResolvedValue({
      environment: makeEnvironment({ id: "env-2", kind: "managedWorktree" }),
      thread: makeThread({ id: "thread-3", environmentId: "env-2" }),
    });
    const refreshSnapshot = vi.fn(async () => false);
    useWorkspaceStore.setState((state) => ({ ...state, refreshSnapshot }));
    useWorkspaceStore.getState().selectThread("thread-1");

    await expect(createManagedWorktreeForSelection()).resolves.toBe(false);

    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().selectedThreadId).toBe("thread-1");
  });

  it("selects the first environment when navigating next with no current selection", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          {
            ...makeWorkspaceSnapshot().projects[0]!,
            environments: [
              makeEnvironment({
                id: "env-1",
                kind: "local",
                name: "Local",
                createdAt: "2026-04-03T08:00:00Z",
              }),
              makeEnvironment({
                id: "env-2",
                kind: "managedWorktree",
                name: "Feature A",
                isDefault: false,
                createdAt: "2026-04-03T09:00:00Z",
              }),
              makeEnvironment({
                id: "env-3",
                kind: "managedWorktree",
                name: "Feature B",
                isDefault: false,
                createdAt: "2026-04-03T10:00:00Z",
              }),
            ],
          },
        ],
      }),
      layout: {
        slots: {
          topLeft: {
            projectId: "project-1",
            environmentId: null,
            threadId: null,
          },
          topRight: null,
          bottomLeft: null,
          bottomRight: null,
        },
        focusedSlot: "topLeft",
        rowRatio: 0.5,
        colRatio: 0.5,
      },
      selectedEnvironmentId: null,
    }));

    expect(selectAdjacentEnvironment("next")).toBe(true);
    expect(useWorkspaceStore.getState().selectedEnvironmentId).toBe("env-1");
  });

  it("selects the last environment when navigating previous with no current selection", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          {
            ...makeWorkspaceSnapshot().projects[0]!,
            environments: [
              makeEnvironment({
                id: "env-1",
                kind: "local",
                name: "Local",
                createdAt: "2026-04-03T08:00:00Z",
              }),
              makeEnvironment({
                id: "env-2",
                kind: "managedWorktree",
                name: "Feature A",
                isDefault: false,
                createdAt: "2026-04-03T09:00:00Z",
              }),
              makeEnvironment({
                id: "env-3",
                kind: "managedWorktree",
                name: "Feature B",
                isDefault: false,
                createdAt: "2026-04-03T10:00:00Z",
              }),
            ],
          },
        ],
      }),
      layout: {
        slots: {
          topLeft: {
            projectId: "project-1",
            environmentId: null,
            threadId: null,
          },
          topRight: null,
          bottomLeft: null,
          bottomRight: null,
        },
        focusedSlot: "topLeft",
        rowRatio: 0.5,
        colRatio: 0.5,
      },
      selectedEnvironmentId: null,
    }));

    expect(selectAdjacentEnvironment("previous")).toBe(true);
    expect(useWorkspaceStore.getState().selectedEnvironmentId).toBe("env-3");
  });

  it("skips collapsed worktrees when navigating environments", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            id: "project-1",
            environments: [
              makeEnvironment({
                id: "env-local-1",
                projectId: "project-1",
                kind: "local",
                isDefault: true,
              }),
            ],
          }),
          makeProject({
            id: "project-2",
            sidebarCollapsed: true,
            environments: [
              makeEnvironment({
                id: "env-local-2",
                projectId: "project-2",
                kind: "local",
                isDefault: true,
              }),
              makeEnvironment({
                id: "env-hidden-2",
                projectId: "project-2",
                kind: "managedWorktree",
                isDefault: false,
              }),
            ],
          }),
          makeProject({
            id: "project-3",
            environments: [
              makeEnvironment({
                id: "env-local-3",
                projectId: "project-3",
                kind: "local",
                isDefault: true,
              }),
              makeEnvironment({
                id: "env-visible-3",
                projectId: "project-3",
                kind: "managedWorktree",
                isDefault: false,
              }),
            ],
          }),
        ],
      }),
      layout: {
        slots: {
          topLeft: {
            projectId: "project-2",
            environmentId: "env-hidden-2",
            threadId: null,
          },
          topRight: null,
          bottomLeft: null,
          bottomRight: null,
        },
        focusedSlot: "topLeft",
        rowRatio: 0.5,
        colRatio: 0.5,
      },
      selectedProjectId: "project-2",
      selectedEnvironmentId: "env-hidden-2",
    }));

    expect(selectAdjacentEnvironment("next")).toBe(true);
    expect(useWorkspaceStore.getState().selectedEnvironmentId).toBe("env-local-3");
  });

  it("preserves a newer thread selection made while the archive confirmation is open", async () => {
    const refreshedSnapshot = makeWorkspaceSnapshot({
      projects: [
        {
          ...makeWorkspaceSnapshot().projects[0]!,
          environments: [
            makeEnvironment({
              threads: [makeThread({ id: "thread-2", title: "Thread 2" })],
            }),
          ],
        },
      ],
    });
    const refreshSnapshot = vi.fn(async () => {
      useWorkspaceStore.setState((state) => ({ ...state, snapshot: refreshedSnapshot }));
      return true;
    });
    useWorkspaceStore.setState((state) => ({
      ...state,
      refreshSnapshot,
    }));
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

    await expect(archivePromise).resolves.toBe(true);

    expect(useWorkspaceStore.getState().selectedThreadId).toBe("thread-2");
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(mockedBridge.archiveThread).toHaveBeenCalledWith({ threadId: "thread-1" });
  });

  it("reselects a remaining active thread when archive refresh fails", async () => {
    confirmMock.mockResolvedValue(true);
    mockedBridge.archiveThread.mockResolvedValue(makeThread({ id: "thread-1" }));
    const refreshSnapshot = vi.fn(async () => false);
    useWorkspaceStore.setState((state) => ({ ...state, refreshSnapshot }));
    useWorkspaceStore.getState().selectThread("thread-1");

    await expect(archiveThreadWithConfirmation("thread-1")).resolves.toBe(false);

    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().selectedThreadId).toBe("thread-2");
    expect(
      useWorkspaceStore.getState().snapshot?.projects[0]?.environments[0]?.threads.map(
        (thread) => thread.id,
      ),
    ).toEqual(["thread-2"]);
  });

  it("does not archive when voice work starts while the archive confirmation is open", async () => {
    let resolveConfirm!: (value: boolean) => void;
    confirmMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve;
        }),
    );

    const archivePromise = archiveThreadWithConfirmation("thread-1");
    useVoiceSessionStore.setState({
      ownerEnvironmentId: "env-1",
      ownerThreadId: "thread-1",
      pendingOutcomesByThreadId: {},
      phase: "recording",
    });
    resolveConfirm(true);

    await expect(archivePromise).resolves.toBe(false);
    expect(mockedBridge.archiveThread).not.toHaveBeenCalled();
  });
});
