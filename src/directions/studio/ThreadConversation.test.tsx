import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import {
  baseComposer,
  capabilitiesFixture,
  makeConversationSnapshot,
  makeEnvironment,
  makeThread,
} from "../../test/fixtures/conversation";
import { teardownConversationListener, useConversationStore } from "../../stores/conversation-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { ThreadConversation } from "./ThreadConversation";

vi.mock("../../lib/bridge", () => ({
  openThreadConversation: vi.fn(),
  sendThreadMessage: vi.fn(),
  interruptThreadTurn: vi.fn(),
  listenToConversationEvents: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);

function resetStores() {
  teardownConversationListener();
  const conversationState = useConversationStore.getState();
  useConversationStore.setState({
    ...conversationState,
    snapshotsByThreadId: {},
    capabilitiesByEnvironmentId: {},
    composerByThreadId: {},
    loadingByThreadId: {},
    errorByThreadId: {},
    listenerReady: false,
  });
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: null,
    bootstrapStatus: null,
    loadingState: "ready",
    error: null,
    refreshSnapshot: vi.fn(async () => {}),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStores();
});

describe("ThreadConversation", () => {
  it("renders the real conversation timeline", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot(),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation environment={makeEnvironment()} thread={makeThread()} />,
    );

    await screen.findByText("Inspect the repository");
    expect(
      screen.getByRole("button", { name: "Show thinking details" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Looking through package.json and the runtime service.")).toBeNull();
    expect(screen.queryByText("3 tests passed")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Show thinking details" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Show Command details" }));

    expect(screen.getByText("bun run test")).toBeInTheDocument();
    expect(
      screen.getByText("Looking through package.json and the runtime service."),
    ).toBeInTheDocument();
    expect(screen.getByText("3 tests passed")).toBeInTheDocument();
    expect(screen.getByText("The workspace looks healthy.")).toBeInTheDocument();
    expect(screen.getByText("1,024 tokens")).toBeInTheDocument();
  });

  it("shows the milestone warning and disables send in plan mode", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        composer: { ...baseComposer, collaborationMode: "plan" },
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation environment={makeEnvironment()} thread={makeThread()} />,
    );

    expect(
      await screen.findByText("Plan mode comes next"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("hides completed empty thinking blocks", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "reasoning",
            id: "reasoning-empty",
            summary: "",
            content: "",
            isStreaming: false,
          },
        ],
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation environment={makeEnvironment()} thread={makeThread()} />,
    );

    await screen.findByText("Thread 1");
    expect(
      screen.queryByRole("button", { name: "Show thinking details" }),
    ).toBeNull();
  });

  it("sends composer-backed input through Enter and keeps Shift+Enter for newlines", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({ status: "idle" }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.sendThreadMessage.mockResolvedValue(
      makeConversationSnapshot({
        status: "running",
        activeTurnId: "turn-live-1",
      }),
    );

    render(
      <ThreadConversation environment={makeEnvironment()} thread={makeThread()} />,
    );

    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText("Message ThreadEx...");
    await user.type(input, "Run");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(input, "tests");
    expect(input).toHaveValue("Run\ntests");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockedBridge.sendThreadMessage).toHaveBeenCalledWith({
        threadId: "thread-1",
        text: "Run\ntests",
        composer: expect.objectContaining({
          model: "gpt-5.4",
          reasoningEffort: "high",
          collaborationMode: "build",
          approvalPolicy: "askToEdit",
        }),
      });
    });
  });
});
