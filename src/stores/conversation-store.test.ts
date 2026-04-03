import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import { makeConversationSnapshot, capabilitiesFixture } from "../test/fixtures/conversation";
import {
  teardownConversationListener,
  useConversationStore,
} from "./conversation-store";
import { useWorkspaceStore } from "./workspace-store";

vi.mock("../lib/bridge", () => ({
  openThreadConversation: vi.fn(),
  sendThreadMessage: vi.fn(),
  interruptThreadTurn: vi.fn(),
  listenToConversationEvents: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);

function resetConversationState() {
  teardownConversationListener();
  const state = useConversationStore.getState();
  useConversationStore.setState({
    ...state,
    snapshotsByThreadId: {},
    capabilitiesByEnvironmentId: {},
    composerByThreadId: {},
    loadingByThreadId: {},
    errorByThreadId: {},
    listenerReady: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetConversationState();
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: null,
    bootstrapStatus: null,
    loadingState: "ready",
    error: null,
    selectedProjectId: null,
    selectedEnvironmentId: null,
    selectedThreadId: null,
    refreshSnapshot: vi.fn(async () => {}),
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
    expect(state.loadingByThreadId["thread-1"]).toBe(false);
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
    expect(state.loadingByThreadId["thread-1"]).toBe(false);
    expect(state.errorByThreadId["thread-1"]).toBeNull();
  });

  it("initializes the runtime listener only once across concurrent calls", async () => {
    let resolveListener: ((value: () => void) => void) | null = null;
    mockedBridge.listenToConversationEvents.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveListener = resolve;
        }),
    );

    const first = useConversationStore.getState().initializeListener();
    const second = useConversationStore.getState().initializeListener();

    expect(mockedBridge.listenToConversationEvents).toHaveBeenCalledTimes(1);
    resolveListener?.(() => undefined);
    await Promise.all([first, second]);

    expect(useConversationStore.getState().listenerReady).toBe(true);
  });
});
