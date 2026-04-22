import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import { dialogConfirmMock } from "../../test/desktop-mock";
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
  createThreadForSelection,
  openThreadDraftForProject,
  selectAdjacentEnvironment,
  selectAdjacentThread,
  sendThreadDraft,
} from "./studioActions";
import { useConversationStore } from "../../stores/conversation-store";

const draftComposer = {
  model: "gpt-5.4",
  reasoningEffort: "high" as const,
  collaborationMode: "build" as const,
  approvalPolicy: "askToEdit" as const,
  serviceTier: null,
};

function makePersistedDraftState(
  text: string,
  projectSelection: { kind: "local" } | { kind: "new"; baseBranch: string; name: string } | null,
) {
  return {
    composerDraft: {
      text,
      images: [],
      mentionBindings: [],
      isRefiningPlan: false,
    },
    composer: draftComposer,
    projectSelection,
  };
}

vi.mock("../../lib/bridge", () => ({
  archiveThread: vi.fn(),
  createChatThread: vi.fn(),
  createManagedWorktree: vi.fn(),
  createThread: vi.fn(),
  getDraftThreadState: vi.fn(),
  saveDraftThreadState: vi.fn(),
  saveThreadComposerDraft: vi.fn(),
  sendThreadMessage: vi.fn(),
}));


const mockedBridge = vi.mocked(bridge);

describe("studioActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogConfirmMock.mockReset();
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
    mockedBridge.getDraftThreadState.mockResolvedValue(null);
    mockedBridge.saveDraftThreadState.mockResolvedValue(undefined);
    mockedBridge.saveThreadComposerDraft.mockResolvedValue(undefined);
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

  it("opens a new chat draft when creating a thread from a selected chat", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [],
        chat: {
          projectId: "skein-chat-workspace",
          title: "Chats",
          rootPath: "/tmp/.skein/chats",
          environments: [
            makeEnvironment({
              id: "chat-env-1",
              projectId: "skein-chat-workspace",
              kind: "chat",
              name: "Chat",
              path: "/tmp/.skein/chats/chat-env-1",
              gitBranch: undefined,
              isDefault: false,
              threads: [makeThread({ id: "chat-thread-1", environmentId: "chat-env-1" })],
            }),
          ],
        },
      }),
      layout: {
        slots: {
          topLeft: {
            projectId: "skein-chat-workspace",
            environmentId: "chat-env-1",
            threadId: "chat-thread-1",
          },
          topRight: null,
          bottomLeft: null,
          bottomRight: null,
        },
        focusedSlot: "topLeft",
        rowRatio: 0.5,
        colRatio: 0.5,
      },
      selectedProjectId: "skein-chat-workspace",
      selectedEnvironmentId: "chat-env-1",
      selectedThreadId: "chat-thread-1",
    }));

    await expect(createThreadForSelection()).resolves.toBe(true);

    expect(mockedBridge.createThread).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().draftBySlot.topLeft).toEqual({
      kind: "chat",
    });
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
    dialogConfirmMock.mockImplementation(
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
    dialogConfirmMock.mockResolvedValue(true);
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
    dialogConfirmMock.mockImplementation(
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

  it("archives chat threads from the sidebar context menu", async () => {
    dialogConfirmMock.mockResolvedValue(true);
    mockedBridge.archiveThread.mockResolvedValue(
      makeThread({
        id: "chat-thread-1",
        environmentId: "chat-env-1",
        status: "archived",
      }),
    );
    const refreshSnapshot = vi.fn(async () => {
      useWorkspaceStore.setState((state) => {
        if (!state.snapshot) return state;
        return {
          ...state,
          snapshot: {
            ...state.snapshot,
            chat: {
              ...state.snapshot.chat,
              environments: [],
            },
          },
        };
      });
      return true;
    });
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [],
        chat: {
          projectId: "skein-chat-workspace",
          title: "Chats",
          rootPath: "/tmp/.skein/chats",
          environments: [
            makeEnvironment({
              id: "chat-env-1",
              projectId: "skein-chat-workspace",
              kind: "chat",
              name: "Chat",
              path: "/tmp/.skein/chats/chat-env-1",
              gitBranch: undefined,
              isDefault: false,
              threads: [
                makeThread({
                  id: "chat-thread-1",
                  environmentId: "chat-env-1",
                  title: "Chat thread",
                }),
              ],
            }),
          ],
        },
      }),
      refreshSnapshot,
      selectedProjectId: "skein-chat-workspace",
      selectedEnvironmentId: "chat-env-1",
      selectedThreadId: "chat-thread-1",
    }));

    await expect(archiveThreadWithConfirmation("chat-thread-1")).resolves.toBe(
      true,
    );

    expect(mockedBridge.archiveThread).toHaveBeenCalledWith({
      threadId: "chat-thread-1",
    });
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  });

  describe("thread draft", () => {
    it("openThreadDraftForProject stores the draft on the focused slot", () => {
      const slot = openThreadDraftForProject("project-1");
      expect(slot).toBe("topLeft");
      expect(useWorkspaceStore.getState().draftBySlot.topLeft).toEqual({
        kind: "project",
        projectId: "project-1",
      });
    });

    it("sendThreadDraft creates a thread and enqueues the first message for the conversation view", async () => {
      const newThread = makeThread({ id: "thread-new", environmentId: "env-1" });
      mockedBridge.createThread.mockResolvedValue(newThread);
      const refreshSnapshot = vi.fn(async () => {
        useWorkspaceStore.setState((state) => {
          if (!state.snapshot) return state;
          const nextProjects = state.snapshot.projects.map((project) =>
            project.id === "project-1"
              ? {
                  ...project,
                  environments: project.environments.map((env) =>
                    env.id === "env-1"
                      ? { ...env, threads: [...env.threads, newThread] }
                      : env,
                  ),
                }
              : project,
          );
          return {
            ...state,
            snapshot: { ...state.snapshot, projects: nextProjects },
          };
        });
        return true;
      });
    useWorkspaceStore.setState((state) => ({ ...state, refreshSnapshot }));
      useWorkspaceStore.getState().openThreadDraft("project-1", "topLeft");

      const result = await sendThreadDraft({
        paneId: "topLeft",
        draft: { kind: "project", projectId: "project-1" },
        persistedState: makePersistedDraftState("Hello", { kind: "local" }),
        projectSelection: { kind: "local" },
        text: "Hello",
      });

      expect(result.ok).toBe(true);
      expect(mockedBridge.createThread).toHaveBeenCalledWith({
        environmentId: "env-1",
        overrides: {
          model: "gpt-5.4",
          reasoningEffort: "high",
          collaborationMode: "build",
          approvalPolicy: "askToEdit",
          serviceTier: null,
          serviceTierOverridden: false,
        },
      });
      expect(mockedBridge.saveThreadComposerDraft).toHaveBeenCalledWith({
        threadId: newThread.id,
        draft: {
          text: "Hello",
          images: [],
          mentionBindings: [],
          isRefiningPlan: false,
        },
      });
      // The draft hands the first message off to ThreadConversation rather
      // than calling bridge.sendThreadMessage itself.
      expect(mockedBridge.sendThreadMessage).not.toHaveBeenCalled();
      expect(
        useConversationStore.getState().pendingFirstMessageByThreadId[
          newThread.id
        ],
      ).toEqual({
        text: "Hello",
        images: [],
        mentionBindings: [],
        composer: draftComposer,
      });
      expect(useWorkspaceStore.getState().draftBySlot.topLeft).toBeUndefined();
      expect(useWorkspaceStore.getState().selectedThreadId).toBe(newThread.id);
    });

    it("sendThreadDraft transfers the latest mention bindings into the new thread draft", async () => {
      const newThread = makeThread({ id: "thread-new", environmentId: "env-1" });
      mockedBridge.createThread.mockResolvedValue(newThread);
      const refreshSnapshot = vi.fn(async () => true);
      useWorkspaceStore.setState((state) => ({ ...state, refreshSnapshot }));
      useWorkspaceStore.getState().openThreadDraft("project-1", "topLeft");

      const result = await sendThreadDraft({
        paneId: "topLeft",
        draft: { kind: "project", projectId: "project-1" },
        persistedState: {
          ...makePersistedDraftState("Old text", { kind: "local" }),
          composerDraft: {
            text: "Old text",
            images: [],
            mentionBindings: [
              {
                mention: "old",
                kind: "skill",
                path: "old",
                start: 0,
                end: 4,
              },
            ],
            isRefiningPlan: false,
          },
        },
        projectSelection: { kind: "local" },
        text: "New text",
        mentionBindings: [
          {
            mention: "fresh",
            kind: "skill",
            path: "fresh",
          },
        ],
        draftMentionBindings: [
          {
            mention: "fresh",
            kind: "skill",
            path: "fresh",
            start: 4,
            end: 10,
          },
        ],
      });

      expect(result.ok).toBe(true);
      expect(mockedBridge.saveThreadComposerDraft).toHaveBeenCalledWith({
        threadId: newThread.id,
        draft: {
          text: "New text",
          images: [],
          mentionBindings: [
            {
              mention: "fresh",
              kind: "skill",
              path: "fresh",
              start: 4,
              end: 10,
            },
          ],
          isRefiningPlan: false,
        },
      });
      expect(
        useConversationStore.getState().pendingFirstMessageByThreadId[
          newThread.id
        ],
      ).toEqual({
        text: "New text",
        images: [],
        mentionBindings: [
          {
            mention: "fresh",
            kind: "skill",
            path: "fresh",
          },
        ],
        composer: draftComposer,
      });
    });

    it("sendThreadDraft with a new-worktree selection forwards baseBranch and name", async () => {
      const newEnv = makeEnvironment({
        id: "env-new",
        kind: "managedWorktree",
      });
      const newThread = makeThread({
        id: "thread-new",
        environmentId: newEnv.id,
      });
      mockedBridge.createManagedWorktree.mockResolvedValue({
        environment: newEnv,
        thread: newThread,
      });
      mockedBridge.sendThreadMessage.mockResolvedValue({
        threadId: newThread.id,
      } as unknown as Awaited<ReturnType<typeof bridge.sendThreadMessage>>);
      const refreshSnapshot = vi.fn(async () => true);
      useWorkspaceStore.setState((state) => ({ ...state, refreshSnapshot }));
      useWorkspaceStore.getState().openThreadDraft("project-1", "topLeft");

      const result = await sendThreadDraft({
        paneId: "topLeft",
        draft: { kind: "project", projectId: "project-1" },
        persistedState: makePersistedDraftState("Investigate crash", {
          kind: "new",
          baseBranch: "main",
          name: "fix/crash",
        }),
        projectSelection: {
          kind: "new",
          baseBranch: "main",
          name: "fix/crash",
        },
        text: "Investigate crash",
      });

      expect(result.ok).toBe(true);
      expect(mockedBridge.createManagedWorktree).toHaveBeenCalledWith(
        "project-1",
        {
          baseBranch: "main",
          name: "fix/crash",
          overrides: {
            model: "gpt-5.4",
            reasoningEffort: "high",
            collaborationMode: "build",
            approvalPolicy: "askToEdit",
            serviceTier: null,
            serviceTierOverridden: false,
          },
        },
      );
      expect(mockedBridge.createThread).not.toHaveBeenCalled();
    });

    it("sendThreadDraft keeps service tier inherited when it matches the global default", async () => {
      const newThread = makeThread({ id: "thread-new", environmentId: "env-1" });
      mockedBridge.createThread.mockResolvedValue(newThread);
      useWorkspaceStore.setState((state) => ({
        ...state,
        snapshot: makeWorkspaceSnapshot({
          settings: {
            ...state.snapshot!.settings,
            defaultServiceTier: "fast",
          },
          projects: state.snapshot?.projects ?? [],
          chat: state.snapshot!.chat,
        }),
      }));
      useWorkspaceStore.getState().openThreadDraft("project-1", "topLeft");

      const result = await sendThreadDraft({
        paneId: "topLeft",
        draft: { kind: "project", projectId: "project-1" },
        persistedState: {
          ...makePersistedDraftState("Hello", { kind: "local" }),
          composer: {
            ...draftComposer,
            serviceTier: "fast",
          },
        },
        projectSelection: { kind: "local" },
        text: "Hello",
      });

      expect(result.ok).toBe(true);
      expect(mockedBridge.createThread).toHaveBeenCalledWith({
        environmentId: "env-1",
        overrides: {
          model: "gpt-5.4",
          reasoningEffort: "high",
          collaborationMode: "build",
          approvalPolicy: "askToEdit",
          serviceTier: "fast",
          serviceTierOverridden: false,
        },
      });
    });

    it("sendThreadDraft still navigates when refreshSnapshot fails", async () => {
      // The bridge committed to the new thread already; failing the local
      // workspace refresh must not bubble up as an error or the user would
      // retry and create a second thread/worktree.
      const newThread = makeThread({ id: "thread-new", environmentId: "env-1" });
      mockedBridge.createThread.mockResolvedValue(newThread);
      const refreshSnapshot = vi.fn(async () => false);
      useWorkspaceStore.setState((state) => ({ ...state, refreshSnapshot }));
      useWorkspaceStore.getState().openThreadDraft("project-1", "topLeft");

      const result = await sendThreadDraft({
        paneId: "topLeft",
        draft: { kind: "project", projectId: "project-1" },
        persistedState: makePersistedDraftState("Hi", { kind: "local" }),
        projectSelection: { kind: "local" },
        text: "Hi",
      });

      expect(result.ok).toBe(true);
      expect(refreshSnapshot).toHaveBeenCalled();
      expect(useWorkspaceStore.getState().draftBySlot.topLeft).toBeUndefined();
      expect(useWorkspaceStore.getState().selectedThreadId).toBe(newThread.id);
    });

    it("sendThreadDraft refuses empty messages", async () => {
      const result = await sendThreadDraft({
        paneId: "topLeft",
        draft: { kind: "project", projectId: "project-1" },
        persistedState: makePersistedDraftState("   ", { kind: "local" }),
        projectSelection: { kind: "local" },
        text: "   ",
      });

      expect(result).toEqual({ ok: false, error: "Message is empty" });
      expect(mockedBridge.createThread).not.toHaveBeenCalled();
    });

    it("sendThreadDraft creates a chat thread when the draft is in chat mode", async () => {
      const chatEnvironment = makeEnvironment({
        id: "env-chat-1",
        projectId: "skein-chat-workspace",
        kind: "chat",
        name: "Chat",
        path: "/tmp/.skein/chats/env-chat-1",
        gitBranch: undefined,
        isDefault: false,
        threads: [],
      });
      const chatThread = makeThread({
        id: "thread-chat-1",
        environmentId: chatEnvironment.id,
      });
      mockedBridge.createChatThread.mockResolvedValue({
        environment: chatEnvironment,
        thread: chatThread,
      });
      const refreshSnapshot = vi.fn(async () => true);
      useWorkspaceStore.setState((state) => ({ ...state, refreshSnapshot }));
      useWorkspaceStore.getState().openChatDraft("topLeft");

      const result = await sendThreadDraft({
        paneId: "topLeft",
        draft: { kind: "chat" },
        persistedState: makePersistedDraftState("Research this topic", null),
        projectSelection: { kind: "local" },
        text: "Research this topic",
      });

      expect(result.ok).toBe(true);
      expect(mockedBridge.createChatThread).toHaveBeenCalledWith({
        overrides: {
          model: "gpt-5.4",
          reasoningEffort: "high",
          collaborationMode: "build",
          approvalPolicy: "askToEdit",
          serviceTier: null,
          serviceTierOverridden: false,
        },
      });
      expect(mockedBridge.createThread).not.toHaveBeenCalled();
      expect(useWorkspaceStore.getState().selectedThreadId).toBe(chatThread.id);
    });

    it("sendThreadDraft still navigates when draft transfer persistence fails", async () => {
      const newThread = makeThread({ id: "thread-new", environmentId: "env-1" });
      mockedBridge.createThread.mockResolvedValue(newThread);
      mockedBridge.saveThreadComposerDraft.mockRejectedValueOnce(
        new Error("transfer failed"),
      );
      const refreshSnapshot = vi.fn(async () => false);
      useWorkspaceStore.setState((state) => ({ ...state, refreshSnapshot }));
      useWorkspaceStore.getState().openThreadDraft("project-1", "topLeft");

      const result = await sendThreadDraft({
        paneId: "topLeft",
        draft: { kind: "project", projectId: "project-1" },
        persistedState: {
          ...makePersistedDraftState("Recovered", { kind: "local" }),
          composerDraft: {
            text: "Recovered",
            images: [],
            mentionBindings: [
              {
                mention: "stale",
                kind: "skill",
                path: "stale",
                start: 0,
                end: 6,
              },
            ],
            isRefiningPlan: false,
          },
        },
        projectSelection: { kind: "local" },
        text: "Recovered",
        mentionBindings: [
          {
            mention: "fresh",
            kind: "skill",
            path: "fresh",
          },
        ],
        draftMentionBindings: [
          {
            mention: "fresh",
            kind: "skill",
            path: "fresh",
            start: 0,
            end: 6,
          },
        ],
      });

      expect(result.ok).toBe(true);
      expect(useWorkspaceStore.getState().selectedThreadId).toBe(newThread.id);
      expect(useWorkspaceStore.getState().draftBySlot.topLeft).toBeUndefined();
      expect(useConversationStore.getState().draftByThreadId[newThread.id]).toEqual({
        text: "Recovered",
        images: [],
        mentionBindings: [
          {
            mention: "fresh",
            kind: "skill",
            path: "fresh",
            start: 0,
            end: 6,
          },
        ],
        isRefiningPlan: false,
      });
      expect(useConversationStore.getState().composerByThreadId[newThread.id]).toEqual(
        draftComposer,
      );
    });

    afterEach(() => {
      useConversationStore.setState((state) => ({
        ...state,
        snapshotsByThreadId: {},
        composerByThreadId: {},
        errorByThreadId: {},
        draftByThreadId: {},
        pendingFirstMessageByThreadId: {},
      }));
    });
  });
});
