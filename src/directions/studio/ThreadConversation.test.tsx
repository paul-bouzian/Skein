import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import {
  baseComposer,
  capabilitiesFixture,
  makeApprovalRequest,
  makeConversationSnapshot,
  makeEnvironment,
  makeProposedPlan,
  makeSubagent,
  makeThread,
  makeUserInputRequest,
} from "../../test/fixtures/conversation";
import {
  teardownConversationListener,
  useConversationStore,
} from "../../stores/conversation-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { ConversationPlanCard } from "./ConversationPlanCard";
import { ThreadConversation } from "./ThreadConversation";

vi.mock("../../lib/bridge", () => ({
  openThreadConversation: vi.fn(),
  refreshThreadConversation: vi.fn(),
  sendThreadMessage: vi.fn(),
  interruptThreadTurn: vi.fn(),
  respondToApprovalRequest: vi.fn(),
  respondToUserInputRequest: vi.fn(),
  submitPlanDecision: vi.fn(),
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
  it("renders the conversation timeline with collapsible thinking and tool details", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot(),
      capabilities: capabilitiesFixture,
    });

    render(<ThreadConversation environment={makeEnvironment()} thread={makeThread()} />);

    await screen.findByText("Inspect the repository");
    expect(screen.getByRole("button", { name: "Show thinking details" })).toBeInTheDocument();
    expect(screen.queryByText("Looking through package.json and the runtime service.")).toBeNull();
    expect(screen.queryByText("3 tests passed")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Show thinking details" }));
    await userEvent.click(screen.getByRole("button", { name: "Show Command details" }));

    expect(
      screen.getByText("Looking through package.json and the runtime service."),
    ).toBeInTheDocument();
    expect(screen.getByText("3 tests passed")).toBeInTheDocument();
  });

  it("renders the subagent strip and context meter for active turns", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "running",
        activeTurnId: "turn-live-1",
        subagents: [
          makeSubagent(),
          makeSubagent({
            threadId: "subagent-2",
            nickname: "Atlas",
            role: "worker",
            depth: 2,
            status: "completed",
          }),
        ],
      }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.refreshThreadConversation.mockResolvedValue(
      makeConversationSnapshot({
        status: "running",
        activeTurnId: "turn-live-1",
        subagents: [makeSubagent()],
      }),
    );

    render(<ThreadConversation environment={makeEnvironment()} thread={makeThread()} />);

    expect(await screen.findByText(/2 subagents \(1 running\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Context window 0.3% used")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Subagents/i }));
    expect(screen.getByText("Scout")).toBeInTheDocument();
    expect(screen.getByText("Atlas")).toBeInTheDocument();
  });

  it("renders the interaction panel and paginates request-user-input questions", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "waitingForExternalAction",
        pendingInteractions: [
          makeUserInputRequest({
            questions: [
              makeUserInputRequest().questions[0],
              {
                id: "question-2",
                header: "Depth",
                question: "How far should Codex go?",
                options: [{ label: "Full", description: "Implement all requested changes" }],
                isOther: false,
                isSecret: false,
              },
            ],
          }),
        ],
      }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.respondToUserInputRequest.mockResolvedValue(
      makeConversationSnapshot({ pendingInteractions: [] }),
    );

    render(<ThreadConversation environment={makeEnvironment()} thread={makeThread()} />);

    expect(await screen.findByText("Codex needs input")).toBeInTheDocument();
    expect(screen.getByText("Question 1 / 2")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Option ARecommended path" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Question 2 / 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "FullImplement all requested changes" }));
    await userEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => {
      expect(mockedBridge.respondToUserInputRequest).toHaveBeenCalledWith({
        threadId: "thread-1",
        interactionId: "interaction-user-input-1",
        answers: {
          "question-1": ["Option A"],
          "question-2": ["Full"],
        },
      });
    });
  });

  it("renders a proposed plan card and continues through approve or refine", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "waitingForExternalAction",
        composer: { ...baseComposer, collaborationMode: "plan" },
        proposedPlan: makeProposedPlan(),
      }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.submitPlanDecision.mockResolvedValue(
      makeConversationSnapshot({
        status: "running",
        composer: { ...baseComposer, collaborationMode: "build" },
        items: [
          ...makeConversationSnapshot().items,
          {
            kind: "system",
            id: "system-plan-approved",
            tone: "info",
            title: "Plan approved",
            body: "ThreadEx approved the current plan and switched the thread to Build mode.",
          },
          {
            kind: "message",
            id: "assistant-build-1",
            role: "assistant",
            text: "Starting implementation now.",
            isStreaming: true,
          },
        ],
        proposedPlan: makeProposedPlan({ status: "approved", isAwaitingDecision: false }),
      }),
    );

    render(<ThreadConversation environment={makeEnvironment()} thread={makeThread()} />);

    expect(await screen.findByRole("button", { name: "Approve plan" })).toBeInTheDocument();
    expect(screen.getByText("Codex clarified the implementation path.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Proposed plan" })).toBeInTheDocument();
    expect(screen.getAllByText("Inspect the runtime layer").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Approve plan" }));

    await waitFor(() => {
      expect(mockedBridge.submitPlanDecision).toHaveBeenCalledWith({
        threadId: "thread-1",
        action: "approve",
        composer: expect.objectContaining({
          collaborationMode: "build",
        }),
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Approve plan")).toBeNull();
      expect(screen.getByText("Starting implementation now.")).toBeInTheDocument();
    });
  });

  it("sends plan-refinement feedback through the composer", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "waitingForExternalAction",
        composer: { ...baseComposer, collaborationMode: "plan" },
        proposedPlan: makeProposedPlan(),
      }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.submitPlanDecision.mockResolvedValue(
      makeConversationSnapshot({
        status: "running",
        composer: { ...baseComposer, collaborationMode: "plan" },
        proposedPlan: makeProposedPlan({
          status: "superseded",
          isAwaitingDecision: false,
        }),
      }),
    );

    render(<ThreadConversation environment={makeEnvironment()} thread={makeThread()} />);

    await screen.findByRole("button", { name: "Refine" });
    await userEvent.click(screen.getByRole("button", { name: "Refine" }));
    const input = screen.getByPlaceholderText("Refine the proposed plan...");
    await userEvent.type(input, "Add explicit rollback coverage");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockedBridge.submitPlanDecision).toHaveBeenCalledWith({
        threadId: "thread-1",
        action: "refine",
        feedback: "Add explicit rollback coverage",
        composer: expect.objectContaining({
          collaborationMode: "plan",
        }),
      });
    });
  });

  it("leaves refine mode on Escape", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "waitingForExternalAction",
        composer: { ...baseComposer, collaborationMode: "plan" },
        proposedPlan: makeProposedPlan(),
      }),
      capabilities: capabilitiesFixture,
    });

    render(<ThreadConversation environment={makeEnvironment()} thread={makeThread()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Refine" }));
    const input = screen.getByPlaceholderText("Refine the proposed plan...");
    await userEvent.type(input, "Need rollback notes");
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByPlaceholderText("Refine the proposed plan...")).toBeNull();
    expect(screen.getByPlaceholderText("Message ThreadEx...")).toBeInTheDocument();
  });

  it("renders approval actions and sends the selected approval response", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "waitingForExternalAction",
        pendingInteractions: [
          makeApprovalRequest({
            proposedExecpolicyAmendment: ["allow bun run test"],
          }),
        ],
      }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.respondToApprovalRequest.mockResolvedValue(
      makeConversationSnapshot({ pendingInteractions: [] }),
    );

    render(<ThreadConversation environment={makeEnvironment()} thread={makeThread()} />);

    expect(await screen.findByText("Command approval")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Allow similar commands" }));

    await waitFor(() => {
      expect(mockedBridge.respondToApprovalRequest).toHaveBeenCalledWith({
        threadId: "thread-1",
        interactionId: "interaction-approval-1",
        response: {
          kind: "commandExecution",
          decision: "acceptWithExecpolicyAmendment",
          execpolicyAmendment: ["allow bun run test"],
        },
      });
    });
  });

  it("keeps Enter-to-send and Shift+Enter for multiline build messages", async () => {
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

    render(<ThreadConversation environment={makeEnvironment()} thread={makeThread()} />);

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
          collaborationMode: "build",
        }),
      });
    });
  });

  it("renders plan markdown even when markdown contains empty list markers", () => {
    render(
      <ConversationPlanCard
        plan={makeProposedPlan({
          markdown: "## Proposed plan\n\n- \n- Keep the second item",
        })}
        onApprove={() => undefined}
        onRefine={() => undefined}
      />,
    );

    expect(screen.getByText("Keep the second item")).toBeInTheDocument();
  });
});
