import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  makeTaskPlan,
  makeThread,
  makeUserInputRequest,
} from "../../test/fixtures/conversation";
import {
  teardownConversationListener,
  useConversationStore,
} from "../../stores/conversation-store";
import { useVoiceStatusStore } from "../../stores/voice-status-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { ConversationMarkdown } from "./ConversationMarkdown";
import { ConversationPlanCard } from "./ConversationPlanCard";
import { ThreadConversation } from "./ThreadConversation";

const openUrlMock = vi.fn();

vi.mock("../../lib/bridge", () => ({
  openThreadConversation: vi.fn(),
  refreshThreadConversation: vi.fn(),
  getThreadComposerCatalog: vi.fn(),
  searchThreadFiles: vi.fn(),
  sendThreadMessage: vi.fn(),
  interruptThreadTurn: vi.fn(),
  respondToApprovalRequest: vi.fn(),
  respondToUserInputRequest: vi.fn(),
  submitPlanDecision: vi.fn(),
  getEnvironmentVoiceStatus: vi.fn(),
  transcribeEnvironmentVoice: vi.fn(),
  listenToConversationEvents: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

const mockedBridge = vi.mocked(bridge);

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
    refreshSnapshot: vi.fn(async () => true),
  }));
  useVoiceStatusStore.setState((state) => ({
    ...state,
    snapshotsByEnvironmentId: {},
    loadingByEnvironmentId: {},
    errorByEnvironmentId: {},
    lastFetchedAtByEnvironmentId: {},
    lastRequestedAtByEnvironmentId: {},
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  openUrlMock.mockReset();
  resetStores();
  mockedBridge.getThreadComposerCatalog.mockResolvedValue({
    prompts: [],
    skills: [],
    apps: [],
  });
  mockedBridge.searchThreadFiles.mockResolvedValue([]);
  mockedBridge.getEnvironmentVoiceStatus.mockResolvedValue({
    environmentId: "env-1",
    available: false,
    authMode: null,
    unavailableReason: "tokenMissing",
    message: "Sign in with ChatGPT before using voice transcription.",
  });
});

describe("ThreadConversation", () => {
  it("renders the conversation timeline with collapsible thinking and tool details", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot(),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    await screen.findByText("Inspect the repository");
    expect(
      screen.getByRole("button", { name: "Show thinking details" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Looking through package.json and the runtime service.",
      ),
    ).toBeNull();
    expect(screen.queryByText("3 tests passed")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Show thinking details" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Show Command details" }),
    );

    expect(
      screen.getByText("Looking through package.json and the runtime service."),
    ).toBeInTheDocument();
    expect(screen.getByText("3 tests passed")).toBeInTheDocument();
  });

  it("renders assistant markdown for regular Codex messages", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "message",
            id: "assistant-markdown-1",
            role: "assistant",
            text: "## Release notes\n\n**Bold guidance** with `bun`.\n\n- First step\n- Second step\n\n```bash\nbun run verify\n```",
            isStreaming: false,
          },
        ],
      }),
      capabilities: capabilitiesFixture,
    });

    const { container } = render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Release notes", level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Bold guidance").tagName).toBe("STRONG");
    expect(screen.getByText("bun").tagName).toBe("CODE");
    expect(screen.getByText("First step")).toBeInTheDocument();
    expect(screen.getByText("Second step")).toBeInTheDocument();
    expect(screen.getByText("bun run verify").closest("pre")).not.toBeNull();
    expect(container.querySelectorAll(".tx-markdown__list")).toHaveLength(1);
  });

  it("renders markdown inside expanded thinking details", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "reasoning",
            id: "reason-markdown-1",
            summary: "**Addressing weather response**",
            content:
              "The response should reuse [OpenAI](https://openai.com/docs) style references.\n\n- Keep `markdown`\n- Avoid raw plaintext",
            isStreaming: false,
          },
        ],
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Show thinking details" }),
    );

    expect(screen.getByText("Addressing weather response").tagName).toBe(
      "STRONG",
    );
    expect(screen.getByRole("link", { name: "OpenAI" })).toHaveAttribute(
      "href",
      "https://openai.com/docs",
    );
    expect(screen.getByText("markdown").tagName).toBe("CODE");
    expect(screen.getByText("Avoid raw plaintext")).toBeInTheDocument();
  });

  it("auto-links bare URLs in markdown and opens them with the desktop opener", async () => {
    const { container } = render(
      <ConversationMarkdown
        markdown={"Review https://openai.com/docs)."}
      />,
    );

    const link = screen.getByRole("link", {
      name: "https://openai.com/docs",
    });
    expect(link).toHaveAttribute("href", "https://openai.com/docs");
    expect(container.textContent).toBe("Review https://openai.com/docs).");

    await userEvent.click(link);

    expect(openUrlMock).toHaveBeenCalledWith("https://openai.com/docs");
  });

  it("keeps malformed protocol-only URL fragments as plain text", () => {
    const { container } = render(
      <ConversationMarkdown markdown={"See https://) for details."} />,
    );

    expect(
      screen.queryByRole("link", {
        name: "https://",
      }),
    ).toBeNull();
    expect(container.textContent).toBe("See https://) for details.");
  });

  it("preserves multiline user messages with the plain-text message class", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "message",
            id: "user-multiline-1",
            role: "user",
            text: "Line one\nLine two",
            isStreaming: false,
          },
        ],
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const body = await screen.findByText((_, element) => {
      return element?.textContent === "Line one\nLine two";
    });

    expect(body).toHaveClass("tx-item__body--message-plain");
  });

  it("renders clickable bare URLs in tool summaries, tool output, and system banners", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "tool",
            id: "tool-links-1",
            toolType: "commandExecution",
            title: "Command",
            status: "completed",
            summary: "Logs: https://threadex.dev/docs",
            output: "Output: https://threadex.dev/output",
          },
          {
            kind: "system",
            id: "system-links-1",
            tone: "info",
            title: "Status",
            body: "Read https://threadex.dev/status for details.",
          },
        ],
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const summaryLink = await screen.findByRole("link", {
      name: "https://threadex.dev/docs",
    });
    expect(summaryLink).toHaveAttribute("href", "https://threadex.dev/docs");

    await userEvent.click(summaryLink);

    expect(openUrlMock).toHaveBeenNthCalledWith(1, "https://threadex.dev/docs");

    await userEvent.click(
      screen.getByRole("button", { name: "Show Command details" }),
    );

    const outputLink = screen.getByRole("link", {
      name: "https://threadex.dev/output",
    });
    const systemLink = screen.getByRole("link", {
      name: "https://threadex.dev/status",
    });

    await userEvent.click(outputLink);
    await userEvent.click(systemLink);

    expect(openUrlMock).toHaveBeenNthCalledWith(2, "https://threadex.dev/output");
    expect(openUrlMock).toHaveBeenNthCalledWith(3, "https://threadex.dev/status");
  });

  it("renders clickable bare URLs in approval interaction copy", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        pendingInteractions: [
          makeApprovalRequest({
            summary: "Summary https://threadex.dev/approval",
            reason: "Reason https://threadex.dev/reason",
          }),
        ],
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const summaryLink = await screen.findByRole("link", {
      name: "https://threadex.dev/approval",
    });
    const reasonLink = screen.getByRole("link", {
      name: "https://threadex.dev/reason",
    });

    await userEvent.click(summaryLink);
    await userEvent.click(reasonLink);

    expect(openUrlMock).toHaveBeenNthCalledWith(1, "https://threadex.dev/approval");
    expect(openUrlMock).toHaveBeenNthCalledWith(2, "https://threadex.dev/reason");
  });

  it("renders clickable bare URLs in plan and task explanations", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        proposedPlan: makeProposedPlan({
          explanation: "Plan docs: https://threadex.dev/plan",
        }),
        taskPlan: makeTaskPlan({
          explanation: "Task docs: https://threadex.dev/task",
        }),
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const planLink = await screen.findByRole("link", {
      name: "https://threadex.dev/plan",
    });
    const taskLink = screen.getByRole("link", {
      name: "https://threadex.dev/task",
    });

    await userEvent.click(planLink);
    await userEvent.click(taskLink);

    expect(openUrlMock).toHaveBeenNthCalledWith(1, "https://threadex.dev/plan");
    expect(openUrlMock).toHaveBeenNthCalledWith(2, "https://threadex.dev/task");
  });

  it("renders clickable bare URLs in unsupported interaction messages", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        pendingInteractions: [
          {
            kind: "unsupported",
            id: "interaction-unsupported-1",
            method: "item/tool/unsupported",
            threadId: "thr_codex_1",
            turnId: "turn-1",
            itemId: "item-unsupported-1",
            title: "Unsupported interaction",
            message: "Follow https://threadex.dev/help for manual steps.",
          },
        ],
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const helpLink = await screen.findByRole("link", {
      name: "https://threadex.dev/help",
    });

    await userEvent.click(helpLink);

    expect(openUrlMock).toHaveBeenCalledWith("https://threadex.dev/help");
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

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    expect(
      await screen.findByText(/2 subagents \(1 running\)/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Context window 0.3% used"),
    ).toBeInTheDocument();
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
                options: [
                  {
                    label: "Full",
                    description: "Implement all requested changes",
                  },
                ],
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

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    expect(await screen.findByText("Codex needs input")).toBeInTheDocument();
    expect(screen.getByText("Question 1 / 2")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Option ARecommended path" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Question 2 / 2")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", {
        name: "FullImplement all requested changes",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Submit answers" }),
    );

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
        proposedPlan: makeProposedPlan({
          status: "approved",
          isAwaitingDecision: false,
        }),
      }),
    );

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Approve plan" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Codex clarified the implementation path."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Proposed plan" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Inspect the runtime layer").length,
    ).toBeGreaterThan(0);
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
      expect(
        screen.getByText("Starting implementation now."),
      ).toBeInTheDocument();
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

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

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

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Refine" }),
    );
    const input = screen.getByPlaceholderText("Refine the proposed plan...");
    await userEvent.type(input, "Need rollback notes");
    await userEvent.keyboard("{Escape}");

    expect(
      screen.queryByPlaceholderText("Refine the proposed plan..."),
    ).toBeNull();
    expect(
      screen.getByPlaceholderText("Message ThreadEx..."),
    ).toBeInTheDocument();
  });

  it("renders task progress inline without proposal actions and keeps the composer available", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "completed",
        composer: { ...baseComposer, collaborationMode: "build" },
        taskPlan: makeTaskPlan({
          status: "completed",
          steps: [
            { step: "Inspect the runtime layer", status: "completed" },
            { step: "Implement the task UI", status: "completed" },
          ],
          markdown:
            "## Tasks\n\n- Inspect the runtime layer\n- Implement the task UI",
        }),
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    expect((await screen.findAllByText("Tasks")).length).toBeGreaterThan(0);
    expect(
      screen.getByText("Codex is working through the implementation."),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Inspect the runtime layer").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Approve plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refine" })).toBeNull();
    expect(screen.queryByText("Codex is still shaping the plan…")).toBeNull();
    expect(
      screen.getByPlaceholderText("Message ThreadEx..."),
    ).not.toBeDisabled();
  });

  it("hides the first-turn empty state when a task tracker is the only visible output", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [],
        status: "completed",
        composer: { ...baseComposer, collaborationMode: "build" },
        taskPlan: makeTaskPlan({
          status: "completed",
          steps: [],
          explanation: "",
          markdown: "## Tasks\n\n- Inspect the runtime layer",
        }),
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    expect(
      (await screen.findAllByText("Inspect the runtime layer")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Ready for the first turn")).toBeNull();
  });

  it("shows the empty state when a task plan exists without renderable content", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [],
        status: "completed",
        composer: { ...baseComposer, collaborationMode: "build" },
        taskPlan: makeTaskPlan({
          steps: [],
          markdown: "",
          explanation: "",
        }),
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    expect(
      await screen.findByText("Ready for the first turn"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Tasks")).toBeNull();
  });

  it("shows the empty state when a non-renderable proposed plan exists", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [],
        status: "completed",
        composer: { ...baseComposer, collaborationMode: "build" },
        proposedPlan: makeProposedPlan({
          status: "approved",
          isAwaitingDecision: false,
        }),
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    expect(
      await screen.findByText("Ready for the first turn"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refine" })).toBeNull();
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

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    expect(await screen.findByText("Command approval")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Allow similar commands" }),
    );

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

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
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
          collaborationMode: "build",
        }),
      });
    });
  });

  it("prevents duplicate sends while a message submission is still in flight", async () => {
    const deferred =
      createDeferred<ReturnType<typeof makeConversationSnapshot>>();
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({ status: "idle" }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.sendThreadMessage.mockReturnValue(deferred.promise);

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const input = await screen.findByPlaceholderText("Message ThreadEx...");
    await userEvent.type(input, "Ship the fix");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockedBridge.sendThreadMessage).toHaveBeenCalledTimes(1);

    deferred.resolve(makeConversationSnapshot({ status: "running" }));
    await waitFor(() => {
      expect(input).toHaveValue("");
    });
  });

  it("ignores Enter while the composer is in IME composition mode", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({ status: "idle" }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const input = await screen.findByPlaceholderText("Message ThreadEx...");
    await userEvent.type(input, "こんにちは");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(mockedBridge.sendThreadMessage).not.toHaveBeenCalled();
    expect(input).toHaveValue("こんにちは");
  });

  it("autocompletes inline prompt tokens anywhere in the draft", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({ status: "idle" }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.getThreadComposerCatalog.mockResolvedValue({
      prompts: [
        {
          name: "review",
          description: "Review the current diff",
          argumentMode: "none",
          argumentNames: [],
          positionalCount: 0,
          argumentHint: null,
        },
      ],
      skills: [],
      apps: [],
    });
    mockedBridge.sendThreadMessage.mockResolvedValue(
      makeConversationSnapshot({
        status: "running",
        activeTurnId: "turn-live-1",
      }),
    );

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText("Message ThreadEx...");
    await user.type(input, "Please use /prom");
    expect(
      await screen.findByRole("option", { name: /prompts:review/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Tab}");
    await waitFor(() => {
      expect(input).toHaveValue("Please use /prompts:review() ");
    });

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockedBridge.sendThreadMessage).toHaveBeenCalledWith({
        threadId: "thread-1",
        text: "Please use /prompts:review()",
        composer: expect.objectContaining({
          collaborationMode: "build",
        }),
      });
    });
  });

  it("adds a trailing space after skill autocomplete selections", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({ status: "idle" }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.getThreadComposerCatalog.mockResolvedValue({
      prompts: [],
      skills: [
        {
          name: "create-pr",
          description: "Draft polished GitHub pull requests in English",
          path: "/tmp/threadex/.codex/skills/create-pr/SKILL.md",
        },
      ],
      apps: [],
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText("Message ThreadEx...");
    await user.type(input, "Use $crea");
    expect(
      await screen.findByRole("option", { name: /create-pr/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Tab}");
    await waitFor(() => {
      expect(input).toHaveValue("Use $create-pr ");
      expect(screen.queryByRole("option", { name: /create-pr/i })).toBeNull();
    });

    await user.type(input, "now");
    expect(input).toHaveValue("Use $create-pr now");
  });

  it("preserves the selected app binding when a $token collides with a skill name", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({ status: "idle" }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.getThreadComposerCatalog.mockResolvedValue({
      prompts: [],
      skills: [
        {
          name: "github",
          description: "GitHub CLI skill",
          path: "/tmp/threadex/.codex/skills/github/SKILL.md",
        },
      ],
      apps: [
        {
          id: "github-app",
          name: "GitHub",
          description: "GitHub connector",
          slug: "github",
          path: "app://github",
        },
      ],
    });
    mockedBridge.sendThreadMessage.mockResolvedValue(
      makeConversationSnapshot({
        status: "running",
        activeTurnId: "turn-live-1",
      }),
    );

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText("Message ThreadEx...");
    await user.type(input, "Use $git");
    expect(
      await screen.findAllByRole("option", { name: /github/i }),
    ).toHaveLength(2);
    await user.keyboard("{ArrowDown}{Tab}{Enter}");

    await waitFor(() => {
      expect(mockedBridge.sendThreadMessage).toHaveBeenCalledWith({
        threadId: "thread-1",
        text: "Use $github",
        composer: expect.objectContaining({
          collaborationMode: "build",
        }),
        mentionBindings: [
          {
            mention: "github",
            kind: "app",
            path: "app://github",
          },
        ],
      });
    });
  });

  it("preserves selected mention bindings when switching threads with a pending draft", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({ status: "idle" }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.getThreadComposerCatalog.mockResolvedValue({
      prompts: [],
      skills: [
        {
          name: "github",
          description: "GitHub CLI skill",
          path: "/tmp/threadex/.codex/skills/github/SKILL.md",
        },
      ],
      apps: [
        {
          id: "github-app",
          name: "GitHub",
          description: "GitHub connector",
          slug: "github",
          path: "app://github",
        },
      ],
    });
    mockedBridge.sendThreadMessage.mockResolvedValue(
      makeConversationSnapshot({
        status: "running",
        activeTurnId: "turn-live-1",
      }),
    );

    const { rerender } = render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText("Message ThreadEx...");
    await user.type(input, "Use $git");
    expect(
      await screen.findAllByRole("option", { name: /github/i }),
    ).toHaveLength(2);
    await user.keyboard("{ArrowDown}{Tab}");

    await waitFor(() => {
      expect(input).toHaveValue("Use $github ");
    });

    rerender(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread({ id: "thread-2" })}
      />,
    );

    const switchedInput = await screen.findByPlaceholderText(
      "Message ThreadEx...",
    );
    expect(switchedInput).toHaveValue("Use $github ");

    await user.type(switchedInput, "now");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockedBridge.sendThreadMessage).toHaveBeenCalledWith({
        threadId: "thread-2",
        text: "Use $github now",
        composer: expect.objectContaining({
          collaborationMode: "build",
        }),
        mentionBindings: [
          {
            mention: "github",
            kind: "app",
            path: "app://github",
          },
        ],
      });
    });
  });

  it("keeps refine mode and draft content when approving a plan fails", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "waitingForExternalAction",
        composer: { ...baseComposer, collaborationMode: "plan" },
        proposedPlan: makeProposedPlan(),
      }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.submitPlanDecision.mockRejectedValue(
      new Error("approval failed"),
    );

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Refine" }),
    );
    const input = screen.getByPlaceholderText("Refine the proposed plan...");
    await userEvent.type(input, "Keep the rollback section");
    await userEvent.click(screen.getByRole("button", { name: "Approve plan" }));

    await waitFor(() => {
      expect(mockedBridge.submitPlanDecision).toHaveBeenCalledTimes(1);
      expect(
        screen.getByPlaceholderText("Refine the proposed plan..."),
      ).toHaveValue("Keep the rollback section");
    });
    expect(
      screen.getByRole("button", { name: "Approve plan" }),
    ).toBeInTheDocument();
  });

  it("renders canonical model ids in the composer even when Codex returns display names", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        composer: { ...baseComposer, model: "gpt-5.4-mini" },
      }),
      capabilities: {
        ...capabilitiesFixture,
        models: [
          {
            id: "gpt-5.4-mini",
            displayName: "GPT-5.4-mini",
            description: "Mini Codex model",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium", "high"],
            isDefault: true,
          },
          {
            id: "gpt-5.4",
            displayName: "GPT-5.4",
            description: "Primary Codex model",
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
            isDefault: false,
          },
        ],
      },
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const modelPicker = await screen.findByRole("button", {
      name: "Model picker",
    });
    expect(modelPicker).toHaveTextContent("gpt-5.4-mini");

    await userEvent.click(modelPicker);

    expect(
      screen.getByRole("option", { name: "gpt-5.4-mini" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "GPT-5.4-mini" })).toBeNull();
    expect(screen.getByRole("listbox", { name: "Model options" })).toHaveStyle({
      zIndex: "50",
    });
  });

  it("preserves backend collaboration labels in the composer", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot(),
      capabilities: {
        ...capabilitiesFixture,
        collaborationModes: [
          { id: "build", label: "Execute", mode: "build" },
          { id: "plan", label: "Strategize", mode: "plan" },
        ],
      },
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const modeToggle = await screen.findByRole("button", {
      name: "Collaboration mode: Execute. Switch to Strategize",
    });
    expect(modeToggle).toHaveTextContent("Execute");
    expect(modeToggle).toHaveAttribute("title", "Switch to Strategize");

    await userEvent.click(modeToggle);

    await waitFor(() => {
      expect(modeToggle).toHaveTextContent("Strategize");
    });
    expect(modeToggle).toHaveAttribute("title", "Switch to Execute");
    expect(screen.queryByRole("option", { name: "Execute" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Strategize" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Build" })).toBeNull();
  });

  it("disables the mode toggle when the target collaboration mode is unsupported", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot(),
      capabilities: {
        ...capabilitiesFixture,
        collaborationModes: [{ id: "build", label: "Execute", mode: "build" }],
      },
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const modeToggle = await screen.findByRole("button", {
      name: "Collaboration mode: Execute",
    });
    expect(modeToggle).toBeDisabled();
    expect(modeToggle).toHaveTextContent("Execute");
    expect(modeToggle).toHaveAttribute("title", "Execute");

    await userEvent.click(modeToggle);

    expect(modeToggle).toHaveTextContent("Execute");
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

  it("renders markdown with semantic heading depth and skips malformed inline tokens", () => {
    render(
      <ConversationMarkdown
        markdown={
          "# Primary heading\n\nBad `` then `code`, bad [ref] then [OpenAI](https://openai.com/docs), bad **** then **bold**."
        }
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Primary heading", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getByRole("link", { name: "OpenAI" })).toHaveAttribute(
      "href",
      "https://openai.com/docs",
    );
    expect(screen.getByText("bold").tagName).toBe("STRONG");
  });

  it("renders single-asterisk emphasis and keeps current mixed-asterisk behavior", () => {
    render(
      <ConversationMarkdown markdown={"*text*\n\n*text**more*\n\n**text*"} />,
    );

    expect(screen.getByText("text").tagName).toBe("EM");
    expect(screen.getByText("text**more").tagName).toBe("EM");
    expect(screen.getByText("**text*").tagName).toBe("P");
  });
});
