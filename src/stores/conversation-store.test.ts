import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import type { ThreadConversationSnapshot } from "../lib/types";
import {
  capabilitiesFixture,
  makeConversationSnapshot,
  makeEnvironment,
  makeProject,
  makeThread,
  makeWorkspaceSnapshot,
} from "../test/fixtures/conversation";
import {
  INITIAL_CONVERSATION_STATE,
  teardownConversationListener,
  useConversationStore,
} from "./conversation-store";
import { useWorkspaceStore } from "./workspace-store";

vi.mock("../lib/bridge", () => ({
  openThreadConversation: vi.fn(),
  saveThreadComposerDraft: vi.fn(),
  refreshThreadConversation: vi.fn(),
  getThreadComposerCatalog: vi.fn(),
  searchThreadFiles: vi.fn(),
  sendThreadMessage: vi.fn(),
  submitPlanDecision: vi.fn(),
  interruptThreadTurn: vi.fn(),
  listenToConversationEvents: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);
type ListenerResolver = (value: (() => void) | PromiseLike<() => void>) => void;

function requireListenerResolver(
  resolver: ListenerResolver | null,
): ListenerResolver {
  if (!resolver) {
    throw new Error("Expected listener initialization to be pending");
  }
  return resolver;
}

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function resetConversationState() {
  teardownConversationListener();
  const state = useConversationStore.getState();
  useConversationStore.setState({
    ...state,
    ...INITIAL_CONVERSATION_STATE,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetConversationState();
  mockedBridge.saveThreadComposerDraft.mockResolvedValue(undefined);
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: null,
    bootstrapStatus: null,
    loadingState: "ready",
    error: null,
    selectedProjectId: null,
    selectedEnvironmentId: null,
    selectedThreadId: null,
    refreshSnapshot: vi.fn(async () => true),
  }));
});

describe("conversation store", () => {
  it("opens a thread and hydrates capabilities", async () => {
    const snapshot = makeConversationSnapshot();
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot,
      capabilities: capabilitiesFixture,
    });

    await useConversationStore.getState().openThread("thread-1");

    const state = useConversationStore.getState();
    expect(state.snapshotsByThreadId["thread-1"]).toEqual(snapshot);
    expect(state.capabilitiesByEnvironmentId["env-1"]).toEqual(capabilitiesFixture);
    expect(state.composerByThreadId["thread-1"]).toEqual(snapshot.composer);
    expect(state.hydrationByThreadId["thread-1"]).toBe("ready");
  });

  it("does not reopen a thread that is already warm", async () => {
    const snapshot = makeConversationSnapshot();
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [
              makeEnvironment({
                id: "env-1",
                runtime: {
                  environmentId: "env-1",
                  state: "running",
                },
                threads: [makeThread({ id: "thread-1", environmentId: "env-1" })],
              }),
            ],
          }),
        ],
      }),
    }));
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: { "thread-1": snapshot },
      capabilitiesByEnvironmentId: { "env-1": capabilitiesFixture },
    }));

    await useConversationStore.getState().openThread("thread-1");

    expect(mockedBridge.openThreadConversation).not.toHaveBeenCalled();
  });

  it("keeps a hydrated thread cached when its runtime is no longer running", async () => {
    const snapshot = makeConversationSnapshot();
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [
              makeEnvironment({
                id: "env-1",
                runtime: {
                  environmentId: "env-1",
                  state: "stopped",
                },
                threads: [makeThread({ id: "thread-1", environmentId: "env-1" })],
              }),
            ],
          }),
        ],
      }),
    }));
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: { "thread-1": snapshot },
      capabilitiesByEnvironmentId: { "env-1": capabilitiesFixture },
      hydrationByThreadId: { "thread-1": "ready" },
    }));

    await useConversationStore.getState().openThread("thread-1");

    expect(mockedBridge.openThreadConversation).not.toHaveBeenCalled();
    expect(useConversationStore.getState().hydrationByThreadId["thread-1"]).toBe("ready");
  });

  it("restores a cached thread to ready hydration when revisiting it", async () => {
    const snapshot = makeConversationSnapshot();
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: { "thread-1": snapshot },
      capabilitiesByEnvironmentId: { "env-1": capabilitiesFixture },
      hydrationByThreadId: { "thread-1": "error" },
      errorByThreadId: { "thread-1": "runtime unavailable" },
    }));

    await useConversationStore.getState().openThread("thread-1");

    expect(mockedBridge.openThreadConversation).not.toHaveBeenCalled();
    expect(useConversationStore.getState().hydrationByThreadId["thread-1"]).toBe("ready");
    expect(useConversationStore.getState().errorByThreadId["thread-1"]).toBeNull();
  });

  it("deduplicates concurrent thread openings", async () => {
    const deferred = deferredPromise<{
      snapshot: ReturnType<typeof makeConversationSnapshot>;
      capabilities: typeof capabilitiesFixture;
    }>();
    mockedBridge.openThreadConversation.mockReturnValue(deferred.promise);

    const first = useConversationStore.getState().openThread("thread-1");
    const second = useConversationStore.getState().openThread("thread-1");

    expect(mockedBridge.openThreadConversation).toHaveBeenCalledTimes(1);

    deferred.resolve({
      snapshot: makeConversationSnapshot(),
      capabilities: capabilitiesFixture,
    });
    await Promise.all([first, second]);
  });

  it("sends a message with the persisted composer selection", async () => {
    const initialSnapshot = makeConversationSnapshot({ status: "idle" });
    const nextSnapshot = makeConversationSnapshot({
      status: "running",
      activeTurnId: "turn-1",
      items: [
        ...initialSnapshot.items,
        {
          kind: "message",
          id: "assistant-2",
          role: "assistant",
          text: "Running now",
          images: null,
          isStreaming: true,
        },
      ],
    });

    mockedBridge.sendThreadMessage.mockResolvedValue(nextSnapshot);
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: { "thread-1": initialSnapshot },
      composerByThreadId: {
        "thread-1": { ...initialSnapshot.composer, reasoningEffort: "xhigh" },
      },
    }));

    await useConversationStore.getState().sendMessage("thread-1", "Ship it");

    expect(mockedBridge.sendThreadMessage).toHaveBeenCalledWith({
      threadId: "thread-1",
      text: "Ship it",
      composer: { ...initialSnapshot.composer, reasoningEffort: "xhigh" },
    });
    expect(useConversationStore.getState().snapshotsByThreadId["thread-1"]).toEqual(
      nextSnapshot,
    );
  });

  it("sends the selected model and reasoning effort to the backend", async () => {
    const initialSnapshot = makeConversationSnapshot({ status: "idle" });
    const nextSnapshot = makeConversationSnapshot({
      status: "running",
      activeTurnId: "turn-2",
      composer: {
        ...initialSnapshot.composer,
        model: "gpt-5.3-codex",
        reasoningEffort: "low",
      },
    });

    mockedBridge.sendThreadMessage.mockResolvedValue(nextSnapshot);
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: { "thread-1": initialSnapshot },
      composerByThreadId: {
        "thread-1": {
          ...initialSnapshot.composer,
          model: "gpt-5.3-codex",
          reasoningEffort: "low",
        },
      },
    }));

    await useConversationStore.getState().sendMessage("thread-1", "Use the configured model");

    expect(mockedBridge.sendThreadMessage).toHaveBeenCalledWith({
      threadId: "thread-1",
      text: "Use the configured model",
      composer: {
        ...initialSnapshot.composer,
        model: "gpt-5.3-codex",
        reasoningEffort: "low",
      },
    });
  });

  it("forwards attached images to the backend", async () => {
    const initialSnapshot = makeConversationSnapshot({ status: "idle" });
    const nextSnapshot = makeConversationSnapshot({
      status: "running",
      activeTurnId: "turn-images-1",
    });

    mockedBridge.sendThreadMessage.mockResolvedValue(nextSnapshot);
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: { "thread-1": initialSnapshot },
      composerByThreadId: { "thread-1": initialSnapshot.composer },
    }));

    await useConversationStore.getState().sendMessage("thread-1", "", [
      { type: "localImage", path: "/tmp/screenshot.png" },
    ]);

    expect(mockedBridge.sendThreadMessage).toHaveBeenCalledWith({
      threadId: "thread-1",
      text: "",
      composer: initialSnapshot.composer,
      images: [{ type: "localImage", path: "/tmp/screenshot.png" }],
    });
  });

  it("keeps sendMessage successful when the workspace refresh fails afterwards", async () => {
    vi.useFakeTimers();
    const initialSnapshot = makeConversationSnapshot({ status: "idle" });
    const nextSnapshot = makeConversationSnapshot({
      status: "running",
      activeTurnId: "turn-3",
    });
    const refreshSnapshot = vi.fn(async () => {
      throw new Error("refresh failed");
    });

    mockedBridge.sendThreadMessage.mockResolvedValue(nextSnapshot);
    useWorkspaceStore.setState((state) => ({
      ...state,
      refreshSnapshot,
    }));
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: { "thread-1": initialSnapshot },
      composerByThreadId: { "thread-1": initialSnapshot.composer },
    }));

    const sent = await useConversationStore.getState().sendMessage("thread-1", "Ship it");

    expect(sent).toBe(true);
    expect(useConversationStore.getState().snapshotsByThreadId["thread-1"]).toEqual(
      nextSnapshot,
    );
    expect(refreshSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(useConversationStore.getState().errorByThreadId["thread-1"]).toBeNull();
  });

  it("clears queued draft persistence after sendMessage succeeds", async () => {
    const initialSnapshot = makeConversationSnapshot({ status: "idle" });
    const nextSnapshot = makeConversationSnapshot({
      status: "running",
      activeTurnId: "turn-send-clear-1",
    });
    const staleSave = deferredPromise<void>();

    mockedBridge.saveThreadComposerDraft
      .mockReturnValueOnce(staleSave.promise)
      .mockResolvedValue(undefined);
    mockedBridge.sendThreadMessage.mockResolvedValue(nextSnapshot);
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: { "thread-1": initialSnapshot },
      composerByThreadId: { "thread-1": initialSnapshot.composer },
    }));

    useConversationStore.getState().updateDraft("thread-1", {
      images: [{ type: "localImage", path: "/tmp/thread-1.png" }],
    });
    await Promise.resolve();

    expect(mockedBridge.saveThreadComposerDraft).toHaveBeenNthCalledWith(1, {
      threadId: "thread-1",
      draft: {
        text: "",
        images: [{ type: "localImage", path: "/tmp/thread-1.png" }],
        mentionBindings: [],
        isRefiningPlan: false,
      },
    });

    await useConversationStore.getState().sendMessage("thread-1", "Ship it");
    expect(useConversationStore.getState().draftByThreadId["thread-1"]).toBeUndefined();

    staleSave.resolve(undefined);
    await staleSave.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedBridge.saveThreadComposerDraft).toHaveBeenNthCalledWith(2, {
      threadId: "thread-1",
      draft: null,
    });
  });

  it("adds an optimistic user message immediately and rolls it back if send fails", async () => {
    const initialSnapshot = makeConversationSnapshot({ status: "idle" });
    const deferred = new Promise<ThreadConversationSnapshot>((_, reject) => {
      queueMicrotask(() => reject(new Error("send failed")));
    });

    mockedBridge.sendThreadMessage.mockReturnValue(deferred);
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: { "thread-1": initialSnapshot },
      composerByThreadId: { "thread-1": initialSnapshot.composer },
    }));

    const sendPromise = useConversationStore
      .getState()
      .sendMessage("thread-1", "Rename the worktree");

    const optimisticSnapshot =
      useConversationStore.getState().snapshotsByThreadId["thread-1"];
    const optimisticItem =
      optimisticSnapshot.items[optimisticSnapshot.items.length - 1];
    expect(optimisticItem).toMatchObject({
      kind: "message",
      role: "user",
      text: "Rename the worktree",
      isStreaming: false,
    });

    const sent = await sendPromise;

    expect(sent).toBe(false);
    expect(useConversationStore.getState().snapshotsByThreadId["thread-1"]).toEqual(
      initialSnapshot,
    );
    expect(useConversationStore.getState().errorByThreadId["thread-1"]).toBe(
      "send failed",
    );
  });

  it("keeps submitPlanDecision successful when the workspace refresh fails afterwards", async () => {
    vi.useFakeTimers();
    const initialSnapshot = makeConversationSnapshot({
      status: "waitingForExternalAction",
    });
    const nextSnapshot = makeConversationSnapshot({
      status: "running",
      activeTurnId: "turn-4",
    });
    const refreshSnapshot = vi.fn(async () => {
      throw new Error("refresh failed");
    });

    mockedBridge.submitPlanDecision.mockResolvedValue(nextSnapshot);
    useWorkspaceStore.setState((state) => ({
      ...state,
      refreshSnapshot,
    }));
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: { "thread-1": initialSnapshot },
      composerByThreadId: { "thread-1": initialSnapshot.composer },
    }));

    const sent = await useConversationStore.getState().submitPlanDecision({
      threadId: "thread-1",
      action: "approve",
      composer: initialSnapshot.composer,
    });

    expect(sent).toBe(true);
    expect(useConversationStore.getState().snapshotsByThreadId["thread-1"]).toEqual(
      nextSnapshot,
    );
    expect(refreshSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(useConversationStore.getState().errorByThreadId["thread-1"]).toBeNull();
  });

  it("clears queued draft persistence after submitPlanDecision succeeds", async () => {
    const initialSnapshot = makeConversationSnapshot({
      status: "waitingForExternalAction",
    });
    const nextSnapshot = makeConversationSnapshot({
      status: "running",
      activeTurnId: "turn-plan-clear-1",
    });
    const staleSave = deferredPromise<void>();

    mockedBridge.saveThreadComposerDraft
      .mockReturnValueOnce(staleSave.promise)
      .mockResolvedValue(undefined);
    mockedBridge.submitPlanDecision.mockResolvedValue(nextSnapshot);
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: { "thread-1": initialSnapshot },
      composerByThreadId: { "thread-1": initialSnapshot.composer },
    }));

    useConversationStore.getState().updateDraft("thread-1", {
      images: [{ type: "localImage", path: "/tmp/thread-1.png" }],
    });
    await Promise.resolve();

    await useConversationStore.getState().submitPlanDecision({
      threadId: "thread-1",
      action: "approve",
      composer: initialSnapshot.composer,
    });
    expect(useConversationStore.getState().draftByThreadId["thread-1"]).toBeUndefined();

    staleSave.resolve(undefined);
    await staleSave.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedBridge.saveThreadComposerDraft).toHaveBeenNthCalledWith(2, {
      threadId: "thread-1",
      draft: null,
    });
  });

  it("refreshes a thread snapshot without reopening the conversation", async () => {
    const snapshot = makeConversationSnapshot({
      status: "running",
      activeTurnId: "turn-live-1",
      subagents: [
        {
          threadId: "subagent-1",
          nickname: "Scout",
          role: "explorer",
          depth: 1,
          status: "running",
        },
      ],
    });
    mockedBridge.refreshThreadConversation.mockResolvedValue(snapshot);

    await useConversationStore.getState().refreshThread("thread-1");

    expect(mockedBridge.refreshThreadConversation).toHaveBeenCalledWith("thread-1");
    expect(useConversationStore.getState().snapshotsByThreadId["thread-1"]).toEqual(snapshot);
  });

  it("applies conversation events from the runtime stream", async () => {
    const snapshot = makeConversationSnapshot({ status: "running" });
    let callback: (payload: {
      threadId: string;
      environmentId: string;
      snapshot: typeof snapshot;
    }) => void = () => undefined;

    mockedBridge.listenToConversationEvents.mockImplementation(async (...args) => {
      callback = args[0] as typeof callback;
      return () => undefined;
    });

    await useConversationStore.getState().initializeListener();
    callback({
      threadId: "thread-1",
      environmentId: "env-1",
      snapshot,
    });

    const state = useConversationStore.getState();
    expect(state.listenerReady).toBe(true);
    expect(state.snapshotsByThreadId["thread-1"]).toEqual(snapshot);
    expect(state.hydrationByThreadId["thread-1"]).toBe("ready");
    expect(state.errorByThreadId["thread-1"]).toBeNull();
  });

  it("initializes the runtime listener only once across concurrent calls", async () => {
    let resolveListener: ListenerResolver | null = null;
    mockedBridge.listenToConversationEvents.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListener = resolve;
        }),
    );

    const first = useConversationStore.getState().initializeListener();
    const second = useConversationStore.getState().initializeListener();

    expect(mockedBridge.listenToConversationEvents).toHaveBeenCalledTimes(1);
    requireListenerResolver(resolveListener)(() => undefined);
    await Promise.all([first, second]);

    expect(useConversationStore.getState().listenerReady).toBe(true);
  });

  it("ignores composer patches before a thread snapshot exists", () => {
    useConversationStore.getState().updateComposer("thread-missing", {
      collaborationMode: "plan",
    });

    expect(useConversationStore.getState().composerByThreadId["thread-missing"]).toBeUndefined();
  });

  it("hydrates a persisted draft when opening a thread", async () => {
    const snapshot = makeConversationSnapshot();
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot,
      capabilities: capabilitiesFixture,
      composerDraft: {
        text: "Restore me",
        images: [{ type: "localImage", path: "/tmp/draft.png" }],
        mentionBindings: [],
        isRefiningPlan: true,
      },
    });

    await useConversationStore.getState().openThread("thread-1");

    expect(useConversationStore.getState().draftByThreadId["thread-1"]).toEqual({
      text: "Restore me",
      images: [{ type: "localImage", path: "/tmp/draft.png" }],
      mentionBindings: [],
      isRefiningPlan: true,
    });
  });

  it("keeps the newer in-memory draft when reopening a thread", async () => {
    const snapshot = makeConversationSnapshot();
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot,
      capabilities: capabilitiesFixture,
      composerDraft: {
        text: "Persisted draft",
        images: [],
        mentionBindings: [],
        isRefiningPlan: false,
      },
    });
    useConversationStore.setState((state) => ({
      ...state,
      draftByThreadId: {
        "thread-1": {
          text: "Local draft",
          images: [],
          mentionBindings: [],
          isRefiningPlan: false,
        },
      },
    }));

    await useConversationStore.getState().openThread("thread-1");

    expect(useConversationStore.getState().draftByThreadId["thread-1"]).toEqual({
      text: "Local draft",
      images: [],
      mentionBindings: [],
      isRefiningPlan: false,
    });
  });

  it("stores drafts separately for each thread", () => {
    useConversationStore.getState().updateDraft("thread-1", {
      text: "Ship it",
      isRefiningPlan: true,
    });
    useConversationStore.getState().updateDraft("thread-2", {
      text: "Leave this alone",
      images: [{ type: "localImage", path: "/tmp/thread-2.png" }],
    });

    const state = useConversationStore.getState();
    expect(state.draftByThreadId["thread-1"]).toMatchObject({
      text: "Ship it",
      images: [],
      mentionBindings: [],
      isRefiningPlan: true,
    });
    expect(state.draftByThreadId["thread-2"]).toMatchObject({
      text: "Leave this alone",
      images: [{ type: "localImage", path: "/tmp/thread-2.png" }],
      mentionBindings: [],
      isRefiningPlan: false,
    });
  });

  it("persists text draft updates with a debounce", async () => {
    vi.useFakeTimers();

    try {
      useConversationStore.getState().updateDraft("thread-1", {
        text: "Ship it",
      });

      expect(mockedBridge.saveThreadComposerDraft).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(249);
      expect(mockedBridge.saveThreadComposerDraft).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mockedBridge.saveThreadComposerDraft).toHaveBeenCalledWith({
        threadId: "thread-1",
        draft: {
          text: "Ship it",
          images: [],
          mentionBindings: [],
          isRefiningPlan: false,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists non-text draft changes immediately", async () => {
    useConversationStore.getState().updateDraft("thread-1", {
      images: [{ type: "localImage", path: "/tmp/thread-1.png" }],
    });
    await Promise.resolve();

    expect(mockedBridge.saveThreadComposerDraft).toHaveBeenCalledWith({
      threadId: "thread-1",
      draft: {
        text: "",
        images: [{ type: "localImage", path: "/tmp/thread-1.png" }],
        mentionBindings: [],
        isRefiningPlan: false,
      },
    });
  });

  it("persists mention binding changes immediately", async () => {
    useConversationStore.getState().updateDraft("thread-1", {
      mentionBindings: [
        {
          mention: "github",
          kind: "app",
          path: "app://github",
          start: 0,
          end: 7,
        },
      ],
    });
    await Promise.resolve();

    expect(mockedBridge.saveThreadComposerDraft).toHaveBeenCalledWith({
      threadId: "thread-1",
      draft: {
        text: "",
        images: [],
        mentionBindings: [
          {
            mention: "github",
            kind: "app",
            path: "app://github",
            start: 0,
            end: 7,
          },
        ],
        isRefiningPlan: false,
      },
    });
  });

  it("retries draft persistence after a save failure", async () => {
    vi.useFakeTimers();

    try {
      mockedBridge.saveThreadComposerDraft
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValue(undefined);

      useConversationStore.getState().updateDraft("thread-1", {
        images: [{ type: "localImage", path: "/tmp/thread-1.png" }],
      });
      await Promise.resolve();

      expect(mockedBridge.saveThreadComposerDraft).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(mockedBridge.saveThreadComposerDraft).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(mockedBridge.saveThreadComposerDraft).toHaveBeenCalledTimes(2);
      expect(mockedBridge.saveThreadComposerDraft).toHaveBeenLastCalledWith({
        threadId: "thread-1",
        draft: {
          text: "",
          images: [{ type: "localImage", path: "/tmp/thread-1.png" }],
          mentionBindings: [],
          isRefiningPlan: false,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears persisted drafts immediately on reset", async () => {
    useConversationStore.setState((state) => ({
      ...state,
      draftByThreadId: {
        "thread-1": {
          text: "Pending work",
          images: [],
          mentionBindings: [],
          isRefiningPlan: false,
        },
      },
    }));

    useConversationStore.getState().resetDraft("thread-1");
    await Promise.resolve();

    expect(useConversationStore.getState().draftByThreadId["thread-1"]).toBeUndefined();
    expect(mockedBridge.saveThreadComposerDraft).toHaveBeenCalledWith({
      threadId: "thread-1",
      draft: null,
    });
  });

  it("resets only the requested thread draft", () => {
    useConversationStore.getState().updateDraft("thread-1", {
      text: "Thread 1",
    });
    useConversationStore.getState().updateDraft("thread-2", {
      text: "Thread 2",
    });

    useConversationStore.getState().resetDraft("thread-1");

    const state = useConversationStore.getState();
    expect(state.draftByThreadId["thread-1"]).toBeUndefined();
    expect(state.draftByThreadId["thread-2"]).toMatchObject({
      text: "Thread 2",
    });
  });

  it("drops an empty draft instead of storing a blank entry", () => {
    useConversationStore.getState().updateDraft("thread-1", {
      text: "Keep this",
    });

    useConversationStore.getState().updateDraft("thread-1", {
      text: "",
      images: [],
      mentionBindings: [],
      isRefiningPlan: false,
    });

    expect(useConversationStore.getState().draftByThreadId["thread-1"]).toBeUndefined();
  });
  it("resets listener readiness on teardown", async () => {
    mockedBridge.listenToConversationEvents.mockResolvedValue(() => undefined);

    await useConversationStore.getState().initializeListener();
    expect(useConversationStore.getState().listenerReady).toBe(true);

    teardownConversationListener();

    expect(useConversationStore.getState().listenerReady).toBe(false);
  });

  it("ignores a listener initialization that resolves after teardown", async () => {
    let resolveListener: ListenerResolver | null = null;
    const unlisten = vi.fn();
    mockedBridge.listenToConversationEvents.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListener = resolve;
        }),
    );

    const pendingInitialization = useConversationStore.getState().initializeListener();
    teardownConversationListener();
    requireListenerResolver(resolveListener)(unlisten);
    await pendingInitialization;

    expect(useConversationStore.getState().listenerReady).toBe(false);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
