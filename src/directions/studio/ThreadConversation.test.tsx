import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import {
  teardownConversationListener,
  useConversationStore,
} from "../../stores/conversation-store";
import { resetVoiceSessionStore } from "../../stores/voice-session-store";
import { useVoiceStatusStore } from "../../stores/voice-status-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { ConversationMarkdown } from "./ConversationMarkdown";
import { ConversationPlanCard } from "./ConversationPlanCard";
import { ThreadConversation } from "./ThreadConversation";

const openUrlMock = vi.fn();
const clipboardWriteTextMock = vi.fn();

vi.mock("../../lib/bridge", () => ({
  openThreadConversation: vi.fn(),
  refreshThreadConversation: vi.fn(),
  getThreadComposerCatalog: vi.fn(),
  searchThreadFiles: vi.fn(),
  readImageAsDataUrl: vi.fn(),
  sendThreadMessage: vi.fn(),
  interruptThreadTurn: vi.fn(),
  respondToApprovalRequest: vi.fn(),
  respondToUserInputRequest: vi.fn(),
  submitPlanDecision: vi.fn(),
  getEnvironmentVoiceStatus: vi.fn(),
  transcribeEnvironmentVoice: vi.fn(),
  listenToConversationEvents: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onDragDropEvent: vi.fn(async () => () => undefined),
  })),
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

function setCompactWorkActivity(enabled: boolean) {
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: makeWorkspaceSnapshot({
      settings: {
        ...makeWorkspaceSnapshot().settings,
        collapseWorkActivity: enabled,
      },
    }),
  }));
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

beforeEach(async () => {
  vi.clearAllMocks();
  openUrlMock.mockReset();
  clipboardWriteTextMock.mockReset();
  clipboardWriteTextMock.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (...args: unknown[]) => clipboardWriteTextMock(...args),
    },
  });
  await resetVoiceSessionStore();
  resetStores();
  mockedBridge.getThreadComposerCatalog.mockResolvedValue({
    prompts: [],
    skills: [],
    apps: [],
  });
  mockedBridge.searchThreadFiles.mockResolvedValue([]);
  mockedBridge.readImageAsDataUrl.mockResolvedValue(
    "data:image/png;base64,aGVsbG8=",
  );
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
    setCompactWorkActivity(false);
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

  it("collapses intermediate work activity into a single live block when the setting is enabled", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        settings: {
          ...makeWorkspaceSnapshot().settings,
          collapseWorkActivity: true,
        },
      }),
    }));
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "message",
            id: "user-compact-1",
            turnId: "turn-compact-1",
            role: "user",
            text: "Inspect the repository",
            images: null,
            isStreaming: false,
          },
          {
            kind: "reasoning",
            id: "reason-compact-1",
            turnId: "turn-compact-1",
            summary: "Inspecting the workspace",
            content: "Looking through package.json and the runtime service.",
            isStreaming: false,
          },
          {
            kind: "tool",
            id: "tool-compact-1",
            turnId: "turn-compact-1",
            toolType: "commandExecution",
            title: "Command",
            status: "completed",
            summary: "bun run test",
            output: "3 tests passed",
          },
          {
            kind: "message",
            id: "assistant-compact-1",
            turnId: "turn-compact-1",
            role: "assistant",
            text: "The workspace looks healthy.",
            images: null,
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

    expect(await screen.findByText("Inspect the repository")).toBeInTheDocument();
    expect(await screen.findByText("The workspace looks healthy.")).toBeInTheDocument();
    expect(screen.getByText("1 thinking · 1 tool call")).toBeInTheDocument();
    expect(
      screen.queryByText("Looking through package.json and the runtime service."),
    ).toBeNull();
    expect(screen.queryByText("3 tests passed")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Show work activity details" }),
    );
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

  it("keeps live assistant updates inside compact work activity until the turn completes", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        settings: {
          ...makeWorkspaceSnapshot().settings,
          collapseWorkActivity: true,
        },
      }),
    }));
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        codexThreadId: null,
        status: "running",
        activeTurnId: "turn-live-update-1",
        items: [
          {
            kind: "message",
            id: "user-live-update-1",
            turnId: "turn-live-update-1",
            role: "user",
            text: "Inspect the repository",
            images: null,
            isStreaming: false,
          },
          {
            kind: "message",
            id: "assistant-live-update-1",
            turnId: "turn-live-update-1",
            role: "assistant",
            text: "I am checking the runtime flow now.",
            images: null,
            isStreaming: true,
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

    expect(await screen.findByText("Inspect the repository")).toBeInTheDocument();
    expect(screen.getByText("1 update")).toBeInTheDocument();
    expect(screen.queryByText("I am checking the runtime flow now.")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Show work activity details" }),
    );

    expect(screen.getByText("I am checking the runtime flow now.")).toBeInTheDocument();
  });

  it("groups turnless live updates under the active compact work activity", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        settings: {
          ...makeWorkspaceSnapshot().settings,
          collapseWorkActivity: true,
        },
      }),
    }));
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        codexThreadId: null,
        status: "running",
        activeTurnId: "turn-live-fallback-1",
        items: [
          {
            kind: "message",
            id: "user-live-fallback-1",
            turnId: "turn-live-fallback-1",
            role: "user",
            text: "Inspect the repository",
            images: null,
            isStreaming: false,
          },
          {
            kind: "message",
            id: "assistant-live-fallback-1",
            role: "assistant",
            text: "Indexing the workspace before answering.",
            images: null,
            isStreaming: true,
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

    expect(await screen.findByText("Inspect the repository")).toBeInTheDocument();
    expect(screen.getByText("1 update")).toBeInTheDocument();
    expect(screen.queryByText("Indexing the workspace before answering.")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Show work activity details" }),
    );

    expect(
      screen.getByText("Indexing the workspace before answering."),
    ).toBeInTheDocument();
  });

  it("renders a fresh compact work activity block as soon as a new turn starts", async () => {
    setCompactWorkActivity(true);
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        codexThreadId: "thr-live-start-1",
        status: "running",
        activeTurnId: "turn-live-start-1",
        items: [
          {
            kind: "message",
            id: "local-user-live-start-1",
            role: "user",
            text: "Inspect the repository again",
            images: null,
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

    expect(
      await screen.findByText("Inspect the repository again"),
    ).toBeInTheDocument();

    const [toggle] = await screen.findAllByRole("button", {
      name: "Show work activity details",
    });
    const group = toggle?.closest("section");
    expect(group).not.toBeNull();
    expect(within(group!).getByText("Running")).toBeInTheDocument();
    expect(within(group!).getByText("Work activity")).toBeInTheDocument();
    expect(within(group!).queryByText(/thinking|tool call|update/i)).toBeNull();
  });

  it("keeps subsequent turnless live updates inside a new compact work activity block", async () => {
    setCompactWorkActivity(true);
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        codexThreadId: "thr-turnless-followup-1",
        status: "running",
        activeTurnId: "turn-turnless-followup-2",
        items: [
          {
            kind: "message",
            id: "user-turnless-followup-1",
            turnId: "turn-turnless-followup-1",
            role: "user",
            text: "Inspect the repository",
            images: null,
            isStreaming: false,
          },
          {
            kind: "reasoning",
            id: "reason-turnless-followup-1",
            turnId: "turn-turnless-followup-1",
            summary: "Inspecting the workspace",
            content: "First turn reasoning.",
            isStreaming: false,
          },
          {
            kind: "message",
            id: "assistant-turnless-followup-1",
            turnId: "turn-turnless-followup-1",
            role: "assistant",
            text: "The workspace looks healthy.",
            images: null,
            isStreaming: false,
          },
          {
            kind: "message",
            id: "local-user-turnless-followup-2",
            role: "user",
            text: "Inspect it one more time",
            images: null,
            isStreaming: false,
          },
          {
            kind: "reasoning",
            id: "reason-turnless-followup-2",
            summary: "Inspecting the workspace again",
            content: "Second turn reasoning.",
            isStreaming: true,
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

    expect(await screen.findByText("Inspect the repository")).toBeInTheDocument();
    expect(screen.getByText("The workspace looks healthy.")).toBeInTheDocument();
    expect(screen.getByText("Inspect it one more time")).toBeInTheDocument();

    const toggles = await screen.findAllByRole("button", {
      name: "Show work activity details",
    });
    expect(toggles).toHaveLength(2);

    const firstGroup = toggles[0]?.closest("section");
    const secondGroup = toggles[1]?.closest("section");
    expect(firstGroup).not.toBeNull();
    expect(secondGroup).not.toBeNull();
    expect(within(firstGroup!).getByText("Completed")).toBeInTheDocument();
    expect(within(secondGroup!).getByText("Running")).toBeInTheDocument();
    expect(within(firstGroup!).getByText("1 thinking")).toBeInTheDocument();
    expect(within(secondGroup!).getByText("1 thinking")).toBeInTheDocument();

    await userEvent.click(toggles[1]!);
    await userEvent.click(
      within(secondGroup!).getByRole("button", { name: "Show thinking details" }),
    );

    expect(within(secondGroup!).getByText("Second turn reasoning.")).toBeInTheDocument();
    expect(within(firstGroup!).queryByText("Second turn reasoning.")).toBeNull();
  });

  it("assigns turnless live updates to the active turn even without an active anchor item", async () => {
    setCompactWorkActivity(true);
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        codexThreadId: "thr-turnless-unanchored-1",
        status: "running",
        activeTurnId: "turn-turnless-unanchored-2",
        items: [
          {
            kind: "message",
            id: "user-turnless-unanchored-1",
            turnId: "turn-turnless-unanchored-1",
            role: "user",
            text: "Inspect the repository",
            images: null,
            isStreaming: false,
          },
          {
            kind: "reasoning",
            id: "reason-turnless-unanchored-1",
            turnId: "turn-turnless-unanchored-1",
            summary: "Inspecting the workspace",
            content: "First turn reasoning.",
            isStreaming: false,
          },
          {
            kind: "message",
            id: "assistant-turnless-unanchored-1",
            turnId: "turn-turnless-unanchored-1",
            role: "assistant",
            text: "The workspace looks healthy.",
            images: null,
            isStreaming: false,
          },
          {
            kind: "reasoning",
            id: "reason-turnless-unanchored-2",
            summary: "Inspecting the workspace again",
            content: "Second turn reasoning without an anchor.",
            isStreaming: true,
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

    expect(await screen.findByText("Inspect the repository")).toBeInTheDocument();
    expect(screen.getByText("The workspace looks healthy.")).toBeInTheDocument();

    const toggles = await screen.findAllByRole("button", {
      name: "Show work activity details",
    });
    expect(toggles).toHaveLength(2);

    const firstGroup = toggles[0]?.closest("section");
    const secondGroup = toggles[1]?.closest("section");
    expect(firstGroup).not.toBeNull();
    expect(secondGroup).not.toBeNull();
    expect(within(firstGroup!).getByText("Completed")).toBeInTheDocument();
    expect(within(secondGroup!).getByText("Running")).toBeInTheDocument();

    await userEvent.click(toggles[1]!);
    await userEvent.click(
      within(secondGroup!).getByRole("button", { name: "Show thinking details" }),
    );

    expect(
      within(secondGroup!).getByText("Second turn reasoning without an anchor."),
    ).toBeInTheDocument();
    expect(
      within(firstGroup!).queryByText("Second turn reasoning without an anchor."),
    ).toBeNull();
  });

  it.each([
    ["failed", "Failed"],
    ["interrupted", "Interrupted"],
  ] as const)(
    "keeps the latest compact work activity status aligned after a %s turn ends",
    async (status, label) => {
      setCompactWorkActivity(true);
      mockedBridge.openThreadConversation.mockResolvedValue({
        snapshot: makeConversationSnapshot({
          status,
          activeTurnId: null,
          items: [
            {
              kind: "message",
              id: `user-${status}-1`,
              turnId: `turn-${status}-1`,
              role: "user",
              text: "Inspect the repository",
              images: null,
              isStreaming: false,
            },
            {
              kind: "tool",
              id: `tool-${status}-1`,
              turnId: `turn-${status}-1`,
              toolType: "commandExecution",
              title: "Command",
              status: "failed",
              summary: "bun run verify",
              output: "command failed",
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

      const toggle = await screen.findByRole("button", {
        name: "Show work activity details",
      });
      const group = toggle.closest("section");
      expect(group).not.toBeNull();
      expect(within(group!).getByText(label)).toBeInTheDocument();
    },
  );

  it("marks the latest compact work activity as waiting when the turn pauses for input", async () => {
    setCompactWorkActivity(true);
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "waitingForExternalAction",
        activeTurnId: null,
        items: [
          {
            kind: "message",
            id: "user-waiting-1",
            turnId: "turn-waiting-1",
            role: "user",
            text: "Inspect the repository",
            images: null,
            isStreaming: false,
          },
          {
            kind: "message",
            id: "assistant-waiting-1",
            turnId: "turn-waiting-1",
            role: "assistant",
            text: "I need approval before I continue.",
            images: null,
            isStreaming: false,
          },
        ],
        pendingInteractions: [makeApprovalRequest({ turnId: "turn-waiting-1" })],
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const toggle = await screen.findByRole("button", {
      name: "Show work activity details",
    });
    const group = toggle.closest("section");
    expect(group).not.toBeNull();
    expect(within(group!).getByText("Waiting")).toBeInTheDocument();
  });

  it("skips whitespace-only completed reasoning from compact work activity summaries", async () => {
    setCompactWorkActivity(true);
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "message",
            id: "user-compact-whitespace-1",
            turnId: "turn-compact-whitespace-1",
            role: "user",
            text: "Inspect the repository",
            images: null,
            isStreaming: false,
          },
          {
            kind: "reasoning",
            id: "reason-compact-whitespace-1",
            turnId: "turn-compact-whitespace-1",
            summary: "   ",
            content: "\n\n",
            isStreaming: false,
          },
          {
            kind: "tool",
            id: "tool-compact-whitespace-1",
            turnId: "turn-compact-whitespace-1",
            toolType: "commandExecution",
            title: "Command",
            status: "completed",
            summary: "bun run test",
            output: "3 tests passed",
          },
          {
            kind: "message",
            id: "assistant-compact-whitespace-1",
            turnId: "turn-compact-whitespace-1",
            role: "assistant",
            text: "The workspace looks healthy.",
            images: null,
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

    const toggle = await screen.findByRole("button", {
      name: "Show work activity details",
    });
    const group = toggle.closest("section");
    expect(group).not.toBeNull();
    expect(within(group!).getByText("1 tool call")).toBeInTheDocument();
    expect(within(group!).queryByText(/thinking/i)).toBeNull();

    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "Show Command details" }));

    expect(
      screen.queryByRole("button", { name: "Show thinking details" }),
    ).toBeNull();
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
            images: null,
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

  it("copies the raw markdown for assistant messages", async () => {
    const markdown =
      "## Release notes\n\n**Bold guidance** with `bun`.\n\n- First step\n- Second step";
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "message",
            id: "assistant-copy-1",
            role: "assistant",
            text: markdown,
            images: null,
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

    await screen.findByRole("heading", { name: "Release notes", level: 2 });
    const copyButton = screen.getByRole("button", { name: "Copy message" });
    await userEvent.click(copyButton);

    await waitFor(() => {
      expect(clipboardWriteTextMock).toHaveBeenCalledWith(markdown);
    });
    await waitFor(() => {
      expect(copyButton).toHaveClass("is-copied");
    });
  });

  it("does not schedule copy feedback after the message row unmounts", async () => {
    const clipboardDeferred = createDeferred<void>();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    clipboardWriteTextMock.mockReturnValueOnce(clipboardDeferred.promise);
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "message",
            id: "assistant-copy-unmount-1",
            role: "assistant",
            text: "Unmount-safe copy",
            images: null,
            isStreaming: false,
          },
        ],
      }),
      capabilities: capabilitiesFixture,
    });

    try {
      const { unmount } = render(
        <ThreadConversation
          environment={makeEnvironment()}
          thread={makeThread()}
        />,
      );

      const copyButton = await screen.findByRole("button", { name: "Copy message" });
      fireEvent.click(copyButton);

      expect(clipboardWriteTextMock).toHaveBeenCalledWith("Unmount-safe copy");
      const timeoutCountBeforeUnmount = setTimeoutSpy.mock.calls.length;

      unmount();
      clipboardDeferred.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(setTimeoutSpy).toHaveBeenCalledTimes(timeoutCountBeforeUnmount);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("renders assistant file references as compact tokens instead of inline paths", async () => {
    const filePath =
      "/Users/tester/.loom/worktrees/loom-019d5b55/lively-dolphin/src/directions/studio/ThreadConversation.tsx";
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "message",
            id: "assistant-file-reference-1",
            role: "assistant",
            text: `Updated [ThreadConversation.tsx](${filePath}:544) to reuse the renderer.`,
            images: null,
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

    const token = await screen.findByText("ThreadConversation.tsx");
    expect(token).toHaveClass("tx-markdown__file-ref");
    expect(token).toHaveAttribute("title", `${filePath}:544`);
    expect(token).toHaveAttribute("data-file-path", filePath);
    expect(token).toHaveAttribute("data-file-line", "544");
    expect(container.textContent).toContain(
      "Updated ThreadConversation.tsx to reuse the renderer.",
    );
    expect(container.textContent).not.toContain(filePath);
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

  it("hides completed reasoning rows when their content is only whitespace", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "reasoning",
            id: "reason-whitespace-1",
            turnId: "turn-whitespace-1",
            summary: "   ",
            content: "\n\n",
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

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Show thinking details" }),
      ).toBeNull();
    });
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
    const multilineMessage = "Line one\nLine two";
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "message",
            id: "user-multiline-1",
            role: "user",
            text: multilineMessage,
            images: null,
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

    const copyButton = screen.getByRole("button", { name: "Copy message" });
    await userEvent.click(copyButton);

    await waitFor(() => {
      expect(clipboardWriteTextMock).toHaveBeenCalledWith(multilineMessage);
    });
    await waitFor(() => {
      expect(copyButton).toHaveClass("is-copied");
    });
  });

  it("copies assistant updates rendered inside compact work activity", async () => {
    setCompactWorkActivity(true);
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        codexThreadId: null,
        status: "running",
        activeTurnId: "turn-copy-update-1",
        items: [
          {
            kind: "message",
            id: "user-copy-update-1",
            turnId: "turn-copy-update-1",
            role: "user",
            text: "Inspect the repository",
            images: null,
            isStreaming: false,
          },
          {
            kind: "message",
            id: "assistant-copy-update-1",
            turnId: "turn-copy-update-1",
            role: "assistant",
            text: "I am checking the runtime flow now.",
            images: null,
            isStreaming: true,
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

    await screen.findByText("Inspect the repository");
    await userEvent.click(
      screen.getByRole("button", { name: "Show work activity details" }),
    );

    const updateRow = screen
      .getByText("I am checking the runtime flow now.")
      .closest(".tx-item--message");
    expect(updateRow).not.toBeNull();
    if (!(updateRow instanceof HTMLElement)) {
      throw new Error("Expected the compact work activity update row to render.");
    }

    await userEvent.click(within(updateRow).getByRole("button", { name: "Copy message" }));

    await waitFor(() => {
      expect(clipboardWriteTextMock).toHaveBeenCalledWith(
        "I am checking the runtime flow now.",
      );
    });
  });

  it("does not render a copy action for image-only messages", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "message",
            id: "assistant-image-only-1",
            role: "assistant",
            text: "",
            images: [{ type: "image", url: "https://example.com/mock.png" }],
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

    await screen.findByRole("img", { name: "Pasted image" });
    expect(
      screen.queryByRole("button", { name: "Copy message" }),
    ).not.toBeInTheDocument();
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
            summary: "Logs: https://loom.dev/docs",
            output: "Output: https://loom.dev/output",
          },
          {
            kind: "system",
            id: "system-links-1",
            tone: "info",
            title: "Status",
            body: "Read https://loom.dev/status for details.",
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
      name: "https://loom.dev/docs",
    });
    expect(summaryLink).toHaveAttribute("href", "https://loom.dev/docs");

    await userEvent.click(summaryLink);

    expect(openUrlMock).toHaveBeenNthCalledWith(1, "https://loom.dev/docs");

    await userEvent.click(
      screen.getByRole("button", { name: "Show Command details" }),
    );

    const outputLink = screen.getByRole("link", {
      name: "https://loom.dev/output",
    });
    const systemLink = screen.getByRole("link", {
      name: "https://loom.dev/status",
    });

    await userEvent.click(outputLink);
    await userEvent.click(systemLink);

    expect(openUrlMock).toHaveBeenNthCalledWith(2, "https://loom.dev/output");
    expect(openUrlMock).toHaveBeenNthCalledWith(3, "https://loom.dev/status");
  });

  it("renders clickable bare URLs in approval interaction copy", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        pendingInteractions: [
          makeApprovalRequest({
            summary: "Summary https://loom.dev/approval",
            reason: "Reason https://loom.dev/reason",
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
      name: "https://loom.dev/approval",
    });
    const reasonLink = screen.getByRole("link", {
      name: "https://loom.dev/reason",
    });

    await userEvent.click(summaryLink);
    await userEvent.click(reasonLink);

    expect(openUrlMock).toHaveBeenNthCalledWith(1, "https://loom.dev/approval");
    expect(openUrlMock).toHaveBeenNthCalledWith(2, "https://loom.dev/reason");
  });

  it("renders clickable bare URLs in plan and task explanations", async () => {
    setCompactWorkActivity(false);
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        proposedPlan: makeProposedPlan({
          explanation: "Plan docs: https://loom.dev/plan",
        }),
        taskPlan: makeTaskPlan({
          explanation: "Task docs: https://loom.dev/task",
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
      name: "https://loom.dev/plan",
    });
    const taskLink = screen.getByRole("link", {
      name: "https://loom.dev/task",
    });

    await userEvent.click(planLink);
    await userEvent.click(taskLink);

    expect(openUrlMock).toHaveBeenNthCalledWith(1, "https://loom.dev/plan");
    expect(openUrlMock).toHaveBeenNthCalledWith(2, "https://loom.dev/task");
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
            message: "Follow https://loom.dev/help for manual steps.",
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
      name: "https://loom.dev/help",
    });

    await userEvent.click(helpLink);

    expect(openUrlMock).toHaveBeenCalledWith("https://loom.dev/help");
  });

  it("renders attached user images in the timeline", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "message",
            id: "user-images-1",
            role: "user",
            text: "",
            images: [
              {
                type: "image",
                url: "data:image/png;base64,aGVsbG8=",
              },
            ],
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

    const image = await screen.findByRole("img", { name: "Pasted image" });
    expect(image).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=");
  });

  it("sends image-only messages from the composer", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({ status: "idle" }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.sendThreadMessage.mockResolvedValue(
      makeConversationSnapshot({
        status: "running",
        activeTurnId: "turn-image-only-1",
      }),
    );
    mockedBridge.readImageAsDataUrl.mockResolvedValue(
      "data:image/png;base64,aGVsbG8=",
    );

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue(["/tmp/diagram.png"]);

    await screen.findByPlaceholderText("Message Loom...");
    await userEvent.click(screen.getByRole("button", { name: "Attach images" }));
    await waitFor(() => {
      expect(screen.getByText("diagram.png")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(mockedBridge.sendThreadMessage).toHaveBeenCalledWith({
        threadId: "thread-1",
        text: "",
        composer: expect.objectContaining({
          collaborationMode: "build",
        }),
        images: [{ type: "localImage", path: "/tmp/diagram.png" }],
      });
    });
  });

  it("renders the subagent strip and context meter for active turns", async () => {
    setCompactWorkActivity(false);
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

  it("moves task progress and subagents into the compact work activity group", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        settings: {
          ...makeWorkspaceSnapshot().settings,
          collapseWorkActivity: true,
        },
      }),
    }));
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        codexThreadId: null,
        status: "running",
        activeTurnId: "turn-live-1",
        items: [
          {
            kind: "message",
            id: "user-live-1",
            turnId: "turn-live-1",
            role: "user",
            text: "Implement the change",
            images: null,
            isStreaming: false,
          },
        ],
        taskPlan: makeTaskPlan({ turnId: "turn-live-1" }),
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

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    expect(await screen.findByText("2 subagents")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Subagents/i })).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Show work activity details" }),
    );

    expect(screen.getByText("Scout")).toBeInTheDocument();
    expect(screen.getByText("Atlas")).toBeInTheDocument();
    expect(screen.getAllByText("Tasks").length).toBeGreaterThan(0);
  });

  it("keeps the last assistant reply visible when trailing work items share the same turn", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        settings: {
          ...makeWorkspaceSnapshot().settings,
          collapseWorkActivity: true,
        },
      }),
    }));
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        items: [
          {
            kind: "message",
            id: "user-tail-1",
            turnId: "turn-tail-1",
            role: "user",
            text: "Inspect the repository",
            images: null,
            isStreaming: false,
          },
          {
            kind: "reasoning",
            id: "reason-tail-1",
            turnId: "turn-tail-1",
            summary: "Inspecting the workspace",
            content: "Looking through package.json and the runtime service.",
            isStreaming: false,
          },
          {
            kind: "message",
            id: "assistant-tail-1",
            turnId: "turn-tail-1",
            role: "assistant",
            text: "The workspace looks healthy.",
            images: null,
            isStreaming: false,
          },
          {
            kind: "system",
            id: "system-tail-1",
            turnId: "turn-tail-1",
            tone: "info",
            title: "Context compacted",
            body: "Codex compacted the conversation history.",
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

    expect(await screen.findByText("The workspace looks healthy.")).toBeInTheDocument();
    expect(screen.queryByText("Codex compacted the conversation history.")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Show work activity details" }),
    );

    expect(screen.getByText("Codex compacted the conversation history.")).toBeInTheDocument();
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

  it("keeps approvals, user input, and proposed plans visible outside compact work activity", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        settings: {
          ...makeWorkspaceSnapshot().settings,
          collapseWorkActivity: true,
        },
      }),
    }));
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "waitingForExternalAction",
        composer: { ...baseComposer, collaborationMode: "plan" },
        items: [
          {
            kind: "message",
            id: "user-plan-1",
            turnId: "turn-plan-1",
            role: "user",
            text: "Plan the change",
            images: null,
            isStreaming: false,
          },
          {
            kind: "reasoning",
            id: "reason-plan-1",
            turnId: "turn-plan-1",
            summary: "Assessing the request",
            content: "Checking the safest way to ship this.",
            isStreaming: false,
          },
        ],
        proposedPlan: makeProposedPlan({ turnId: "turn-plan-1" }),
        pendingInteractions: [makeUserInputRequest({ turnId: "turn-plan-1" })],
      }),
      capabilities: capabilitiesFixture,
    });

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    expect(await screen.findByText("Work activity")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Proposed plan" })).toBeInTheDocument();
    expect(screen.getByText("Codex needs input")).toBeInTheDocument();
    expect(screen.queryByText("Checking the safest way to ship this.")).toBeNull();
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
            body: "Loom approved the current plan and switched the thread to Build mode.",
          },
          {
            kind: "message",
            id: "assistant-build-1",
            role: "assistant",
            text: "Starting implementation now.",
            images: null,
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
      expect(screen.getByText("Plan approved")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Loom approved the current plan and switched the thread to Build mode.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Starting implementation now."),
      ).toBeInTheDocument();
    });
  });

  it("does not replay approve-or-submit shortcuts while a plan approval is already in flight", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "waitingForExternalAction",
        composer: { ...baseComposer, collaborationMode: "plan" },
        proposedPlan: makeProposedPlan(),
      }),
      capabilities: capabilitiesFixture,
    });
    const approval = createDeferred<ReturnType<typeof makeConversationSnapshot>>();
    mockedBridge.submitPlanDecision.mockImplementation(() => approval.promise);

    const { rerender } = render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
        approveOrSubmitKey={0}
      />,
    );

    await screen.findByRole("button", { name: "Approve plan" });

    rerender(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
        approveOrSubmitKey={1}
      />,
    );
    rerender(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
        approveOrSubmitKey={2}
      />,
    );

    await waitFor(() => {
      expect(mockedBridge.submitPlanDecision).toHaveBeenCalledTimes(1);
    });

    approval.resolve(
      makeConversationSnapshot({
        status: "running",
        composer: { ...baseComposer, collaborationMode: "build" },
        proposedPlan: makeProposedPlan({
          status: "approved",
          isAwaitingDecision: false,
        }),
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Approve plan" })).toBeNull();
    });
  });

  it("does not auto-approve a plan while another interaction is pending", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "waitingForExternalAction",
        composer: { ...baseComposer, collaborationMode: "plan" },
        proposedPlan: makeProposedPlan(),
        pendingInteractions: [makeApprovalRequest()],
      }),
      capabilities: capabilitiesFixture,
    });

    const { rerender } = render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
        approveOrSubmitKey={0}
      />,
    );

    await screen.findByRole("button", { name: "Approve plan" });

    rerender(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
        approveOrSubmitKey={1}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedBridge.submitPlanDecision).not.toHaveBeenCalled();
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

  it("requires text before sending a plan refinement even with attached images", async () => {
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

    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue(["/tmp/diagram.png"]);

    await userEvent.click(
      await screen.findByRole("button", { name: "Refine" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach images" }));

    await waitFor(() => {
      expect(screen.getByText("diagram.png")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Refine plan" })).toBeDisabled();
    expect(mockedBridge.submitPlanDecision).not.toHaveBeenCalled();
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
      screen.getByPlaceholderText("Message Loom..."),
    ).toBeInTheDocument();
  });

  it("renders task progress inline without proposal actions and keeps the composer available", async () => {
    setCompactWorkActivity(false);
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
      screen.getByPlaceholderText("Message Loom..."),
    ).not.toBeDisabled();
  });

  it("hides the first-turn empty state when a task tracker is the only visible output", async () => {
    setCompactWorkActivity(false);
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
    const input = await screen.findByPlaceholderText("Message Loom...");
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

    const input = await screen.findByPlaceholderText("Message Loom...");
    await userEvent.type(input, "Ship the fix");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockedBridge.sendThreadMessage).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(input).toHaveValue("");
    });
    expect(
      screen.queryByText("Naming the branch and worktree"),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("Ship the fix")).toBeInTheDocument();

    deferred.resolve(makeConversationSnapshot({ status: "running" }));
    await expect(deferred.promise).resolves.toMatchObject({
      status: "running",
    });
    await waitFor(() => {
      expect(
        useConversationStore.getState().snapshotsByThreadId["thread-1"]?.status,
      ).toBe("running");
    });
  });

  it("restores the full draft after a send failure", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({ status: "idle" }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.sendThreadMessage.mockRejectedValue(new Error("send failed"));

    render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const input = await screen.findByPlaceholderText("Message Loom...");
    await userEvent.type(input, "  Ship the fix  ");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockedBridge.sendThreadMessage).toHaveBeenCalledWith({
        threadId: "thread-1",
        text: "Ship the fix",
        composer: expect.objectContaining({
          collaborationMode: "build",
        }),
      });
    });
    await waitFor(() => {
      expect(input).toHaveValue("  Ship the fix  ");
    });
  });

  it("shows a naming loader while the first managed worktree prompt is preparing", async () => {
    const deferred =
      createDeferred<ReturnType<typeof makeConversationSnapshot>>();
    const thread = makeThread({
      codexThreadId: undefined,
      title: "Thread 1",
    });
    const environment = makeEnvironment({
      kind: "managedWorktree",
      isDefault: false,
      name: "hazy-linnet",
      path: "/tmp/hazy-linnet",
      gitBranch: "hazy-linnet",
      threads: [thread],
    });

    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "idle",
        codexThreadId: undefined,
        items: [],
      }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.sendThreadMessage.mockReturnValue(deferred.promise);

    render(
      <ThreadConversation
        environment={environment}
        thread={thread}
      />,
    );

    const input = await screen.findByPlaceholderText("Message Loom...");
    await userEvent.type(input, "Add theme support");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(input).toHaveValue("");
    });
    expect(await screen.findByText("Add theme support")).toBeInTheDocument();
    expect(
      await screen.findByText("Naming the branch and worktree"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Preparing a readable label before Codex starts/i),
    ).toBeInTheDocument();

    deferred.resolve(
      makeConversationSnapshot({
        status: "running",
        activeTurnId: "turn-live-1",
        items: [
          {
            kind: "message",
            id: "user-live-1",
            turnId: "turn-live-1",
            role: "user",
            text: "Add theme support",
            images: null,
            isStreaming: false,
          },
        ],
      }),
    );

    await waitFor(() => {
      expect(
        screen.queryByText("Naming the branch and worktree"),
      ).not.toBeInTheDocument();
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

    const input = await screen.findByPlaceholderText("Message Loom...");
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
    const input = await screen.findByPlaceholderText("Message Loom...");
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
          path: "/tmp/loom/.codex/skills/create-pr/SKILL.md",
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
    const input = await screen.findByPlaceholderText("Message Loom...");
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
          path: "/tmp/loom/.codex/skills/github/SKILL.md",
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
    const input = await screen.findByPlaceholderText("Message Loom...");
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
          path: "/tmp/loom/.codex/skills/github/SKILL.md",
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
    const input = await screen.findByPlaceholderText("Message Loom...");
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
      "Message Loom...",
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

  it("clears attached images when switching threads", async () => {
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({ status: "idle" }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.sendThreadMessage.mockResolvedValue(
      makeConversationSnapshot({
        status: "running",
        activeTurnId: "turn-thread-switch-1",
      }),
    );

    const { rerender } = render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue(["/tmp/thread-a.png"]);

    await userEvent.click(
      await screen.findByRole("button", { name: "Attach images" }),
    );
    await waitFor(() => {
      expect(screen.getByText("thread-a.png")).toBeInTheDocument();
    });

    rerender(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread({ id: "thread-2" })}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("thread-a.png")).toBeNull();
    });

    await userEvent.type(
      await screen.findByPlaceholderText("Message Loom..."),
      "Only text here",
    );
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockedBridge.sendThreadMessage).toHaveBeenCalledWith({
        threadId: "thread-2",
        text: "Only text here",
        composer: expect.objectContaining({
          collaborationMode: "build",
        }),
      });
    });
  });

  it("does not keep a previous thread submission in flight after switching threads", async () => {
    const pendingSend =
      createDeferred<ReturnType<typeof makeConversationSnapshot>>();
    mockedBridge.openThreadConversation.mockImplementation(async (threadId) => ({
      snapshot:
        threadId === "thread-2"
          ? makeConversationSnapshot({
              status: "waitingForExternalAction",
              composer: { ...baseComposer, collaborationMode: "plan" },
              proposedPlan: makeProposedPlan(),
            })
          : makeConversationSnapshot({ status: "idle" }),
      capabilities: capabilitiesFixture,
    }));
    mockedBridge.sendThreadMessage.mockReturnValue(pendingSend.promise);
    mockedBridge.submitPlanDecision.mockResolvedValue(
      makeConversationSnapshot({
        status: "running",
        composer: { ...baseComposer, collaborationMode: "build" },
        proposedPlan: makeProposedPlan({
          status: "approved",
          isAwaitingDecision: false,
        }),
      }),
    );

    const { rerender } = render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const input = await screen.findByPlaceholderText("Message Loom...");
    await userEvent.type(input, "Ship the fix");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockedBridge.sendThreadMessage).toHaveBeenCalledTimes(1);
    });

    rerender(
      <ThreadConversation
        environment={makeEnvironment({
          id: "env-2",
          threads: [makeThread({ id: "thread-2" })],
        })}
        thread={makeThread({ id: "thread-2" })}
      />,
    );

    const approveButton = await screen.findByRole("button", {
      name: "Approve plan",
    });
    expect(approveButton).toBeEnabled();

    await userEvent.click(approveButton);

    await waitFor(() => {
      expect(mockedBridge.submitPlanDecision).toHaveBeenCalledWith({
        threadId: "thread-2",
        action: "approve",
        composer: expect.objectContaining({
          collaborationMode: "build",
        }),
      });
    });
  });

  it("ignores a stale send failure after switching threads", async () => {
    const pendingSend =
      createDeferred<ReturnType<typeof makeConversationSnapshot>>();
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({ status: "idle" }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.sendThreadMessage.mockImplementationOnce(
      () => pendingSend.promise,
    );

    const { rerender } = render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    const input = await screen.findByPlaceholderText("Message Loom...");
    await userEvent.type(input, "Ship the fix");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockedBridge.sendThreadMessage).toHaveBeenCalledTimes(1);
    });

    rerender(
      <ThreadConversation
        environment={makeEnvironment({
          id: "env-2",
          threads: [makeThread({ id: "thread-2" })],
        })}
        thread={makeThread({ id: "thread-2" })}
      />,
    );

    const switchedInput = await screen.findByPlaceholderText("Message Loom...");
    await userEvent.type(switchedInput, "New thread draft");

    pendingSend.reject(new Error("send failed"));

    await waitFor(() => {
      expect(switchedInput).toHaveValue("New thread draft");
    });
  });

  it("ignores a stale plan approval completion after switching threads", async () => {
    const pendingApproval =
      createDeferred<ReturnType<typeof makeConversationSnapshot>>();
    mockedBridge.openThreadConversation.mockResolvedValue({
      snapshot: makeConversationSnapshot({
        status: "waitingForExternalAction",
        composer: { ...baseComposer, collaborationMode: "plan" },
        proposedPlan: makeProposedPlan(),
      }),
      capabilities: capabilitiesFixture,
    });
    mockedBridge.submitPlanDecision.mockImplementation((input) => {
      if (input.threadId === "thread-1") {
        return pendingApproval.promise;
      }

      return Promise.resolve(
        makeConversationSnapshot({
          status: "running",
          composer: { ...baseComposer, collaborationMode: "build" },
          proposedPlan: makeProposedPlan({
            status: "approved",
            isAwaitingDecision: false,
          }),
        }),
      );
    });

    const { rerender } = render(
      <ThreadConversation
        environment={makeEnvironment()}
        thread={makeThread()}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Approve plan" }),
    );

    await waitFor(() => {
      expect(mockedBridge.submitPlanDecision).toHaveBeenCalledWith({
        threadId: "thread-1",
        action: "approve",
        composer: expect.objectContaining({
          collaborationMode: "build",
        }),
      });
    });

    rerender(
      <ThreadConversation
        environment={makeEnvironment({
          id: "env-2",
          threads: [makeThread({ id: "thread-2" })],
        })}
        thread={makeThread({ id: "thread-2" })}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Refine" }),
    );
    const input = screen.getByPlaceholderText("Refine the proposed plan...");
    await userEvent.type(input, "Keep the rollback section");

    pendingApproval.resolve(
      makeConversationSnapshot({
        status: "running",
        composer: { ...baseComposer, collaborationMode: "build" },
        proposedPlan: makeProposedPlan({
          status: "approved",
          isAwaitingDecision: false,
        }),
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Refine the proposed plan..."),
      ).toHaveValue("Keep the rollback section");
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
            inputModalities: ["text", "image"],
            isDefault: true,
          },
          {
            id: "gpt-5.4",
            displayName: "GPT-5.4",
            description: "Primary Codex model",
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
            inputModalities: ["text", "image"],
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
