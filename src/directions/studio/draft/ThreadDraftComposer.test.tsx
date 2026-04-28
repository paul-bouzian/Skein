import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../../lib/bridge";
import {
  INITIAL_CONVERSATION_STATE,
  teardownConversationListener,
  useConversationStore,
} from "../../../stores/conversation-store";
import { useWorkspaceStore } from "../../../stores/workspace-store";
import {
  capabilitiesFixture,
  makeEnvironment,
  makeProject,
  makeWorkspaceSnapshot,
} from "../../../test/fixtures/conversation";
import { sendThreadDraft } from "../studioActions";
import { ThreadDraftComposer } from "./ThreadDraftComposer";

let latestEnvironmentSelectorProps: {
  value: unknown;
  onChange: (value: unknown) => void;
} | null = null;
let latestInlineComposerProps: {
  draft: string;
  images: Array<{ type: string }>;
  composer: { model: string; provider?: string };
  modelOptions: Array<{
    id: string;
    displayName: string;
    inputModalities?: string[];
    provider?: string;
  }>;
  catalogTarget?: unknown;
  fileSearchTarget?: unknown;
  transportEnabled?: boolean;
  onSend: (
    text: string,
    images: Array<{ type: string }>,
    mentionBindings: [],
    draftMentionBindings: [],
  ) => void;
} | null = null;

vi.mock("../../../lib/bridge", () => ({
  getDraftThreadState: vi.fn(),
  getEnvironmentCapabilities: vi.fn(),
  getProjectIcon: vi.fn().mockResolvedValue(null),
  listProjectBranches: vi.fn(),
  saveDraftThreadState: vi.fn(),
}));

vi.mock("../composer/InlineComposer", () => ({
  InlineComposer: ({
    composer,
    draft,
    images,
    catalogTarget,
    modelOptions,
    fileSearchTarget,
    transportEnabled,
    onSend,
  }: {
    composer: { model: string; provider?: string };
    draft: string;
    images: Array<{ type: string }>;
    catalogTarget?: unknown;
    modelOptions: Array<{
      id: string;
      displayName: string;
      inputModalities?: string[];
      provider?: string;
    }>;
    fileSearchTarget?: unknown;
    transportEnabled?: boolean;
    onSend: (
      text: string,
      images: Array<{ type: string }>,
      mentionBindings: [],
      draftMentionBindings: [],
    ) => void;
  }) => {
    latestInlineComposerProps = {
      composer,
      draft,
      images,
      modelOptions,
      catalogTarget,
      fileSearchTarget,
      transportEnabled,
      onSend,
    };
    return (
      <div data-testid="inline-composer">
        {modelOptions.map((model) => model.id).join(",")}
      </div>
    );
  },
}));

vi.mock("./EnvironmentSelector", () => ({
  EnvironmentSelector: (props: {
    value: unknown;
    onChange: (value: unknown) => void;
  }) => {
    latestEnvironmentSelectorProps = props;
    return <div data-testid="env-selector" />;
  },
}));

vi.mock("../studioActions", () => ({
  sendThreadDraft: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);
const mockedSendThreadDraft = vi.mocked(sendThreadDraft);

function resetConversationState() {
  teardownConversationListener();
  const state = useConversationStore.getState();
  useConversationStore.setState({
    ...state,
    ...INITIAL_CONVERSATION_STATE,
  });
}

describe("ThreadDraftComposer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    latestEnvironmentSelectorProps = null;
    latestInlineComposerProps = null;
    resetConversationState();
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    mockedBridge.getDraftThreadState.mockResolvedValue(null);
    mockedBridge.listProjectBranches.mockResolvedValue(["main"]);
    mockedBridge.saveDraftThreadState.mockResolvedValue(undefined);
    mockedBridge.getEnvironmentCapabilities.mockResolvedValue({
      ...capabilitiesFixture,
      environmentId: "env-local",
      models: [
        {
          ...capabilitiesFixture.models[0]!,
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          isDefault: true,
        },
        {
          ...capabilitiesFixture.models[0]!,
          id: "gpt-5.4-mini",
          displayName: "GPT-5.4-mini",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high"],
          isDefault: false,
        },
        {
          ...capabilitiesFixture.models[0]!,
          provider: "claude",
          id: "claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: ["low", "medium", "high", "max"],
          inputModalities: ["text", "image"],
          supportedServiceTiers: ["fast"],
          supportsThinking: true,
          isDefault: false,
        },
      ],
    });
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            id: "project-1",
            environments: [
              makeEnvironment({
                id: "env-local",
                kind: "local",
                name: "Local",
              }),
            ],
          }),
        ],
      }),
    }));
  });

  it("loads the local environment capabilities before any thread is opened", async () => {
    render(
      <ThreadDraftComposer
        draft={{ kind: "project", projectId: "project-1" }}
        paneId="topLeft"
      />,
    );

    await waitFor(() => {
      expect(mockedBridge.getEnvironmentCapabilities).toHaveBeenCalledWith(
        "env-local",
      );
    });

    await waitFor(() => {
      expect(
        latestInlineComposerProps?.modelOptions.map((model) => model.id),
      ).toEqual(
        expect.arrayContaining([
          "gpt-5.4",
          "gpt-5.4-mini",
          "claude-sonnet-4-6",
        ]),
      );
      expect(
        latestInlineComposerProps?.modelOptions.find(
          (model) => model.id === "gpt-5.4",
        )?.inputModalities,
      ).toContain("image");
    });
  });

  it("keeps canonical OpenAI fallback models when runtime capabilities are partial", async () => {
    mockedBridge.getEnvironmentCapabilities.mockResolvedValueOnce({
      ...capabilitiesFixture,
      environmentId: "env-local",
      models: [
        {
          ...capabilitiesFixture.models[0]!,
          provider: "claude",
          id: "claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: ["low", "medium", "high", "max"],
          inputModalities: ["text", "image"],
          supportedServiceTiers: ["fast"],
          supportsThinking: true,
          isDefault: false,
        },
      ],
    });

    render(
      <ThreadDraftComposer
        draft={{ kind: "project", projectId: "project-1" }}
        paneId="topLeft"
      />,
    );

    await waitFor(() => {
      expect(
        latestInlineComposerProps?.modelOptions.map((model) => model.id),
      ).toEqual(
        expect.arrayContaining([
          "gpt-5.5",
          "gpt-5.4",
          "gpt-5.4-mini",
          "gpt-5.3-codex",
          "claude-sonnet-4-6",
        ]),
      );
    });
  });

  it("shows the first draft message optimistically while creating the thread", async () => {
    let resolveSend!: (value: { ok: false; error: string }) => void;
    const sendPromise = new Promise<{ ok: false; error: string }>((resolve) => {
      resolveSend = resolve;
    });
    mockedSendThreadDraft.mockReturnValueOnce(sendPromise);
    mockedBridge.getDraftThreadState.mockResolvedValueOnce({
      composerDraft: {
        text: "Bonjour instant",
        images: [],
        mentionBindings: [],
        isRefiningPlan: false,
      },
      composer: {
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
        collaborationMode: "build",
        approvalPolicy: "askToEdit",
        serviceTier: null,
      },
      projectSelection: { kind: "local" },
    });

    render(
      <ThreadDraftComposer
        draft={{ kind: "project", projectId: "project-1" }}
        paneId="topLeft"
      />,
    );

    await waitFor(() => {
      expect(latestInlineComposerProps?.draft).toBe("Bonjour instant");
    });

    act(() => {
      latestInlineComposerProps?.onSend("Bonjour instant", [], [], []);
    });

    await waitFor(() => {
      expect(screen.getByText("Bonjour instant")).toBeInTheDocument();
      expect(latestInlineComposerProps?.draft).toBe("");
    });

    await act(async () => {
      resolveSend({ ok: false, error: "Thread creation failed" });
      await sendPromise;
    });

    await waitFor(() => {
      expect(screen.queryByText("Bonjour instant")).toBeNull();
      expect(latestInlineComposerProps?.draft).toBe("Bonjour instant");
    });
  });

  it("preserves the previous project target when switching chat mode back to a project", async () => {
    const { rerender } = render(
      <ThreadDraftComposer
        draft={{ kind: "project", projectId: "project-1" }}
        paneId="topLeft"
      />,
    );

    expect(latestEnvironmentSelectorProps).not.toBeNull();

    act(() => {
      latestEnvironmentSelectorProps?.onChange({
        kind: "project",
        projectId: "project-1",
        target: { kind: "new", baseBranch: "main", name: "feature-chat" },
      });
    });

    rerender(<ThreadDraftComposer draft={{ kind: "chat" }} paneId="topLeft" />);

    act(() => {
      latestEnvironmentSelectorProps?.onChange({
        kind: "project",
        projectId: "project-1",
        target: { kind: "local" },
      });
    });

    rerender(
      <ThreadDraftComposer
        draft={{ kind: "project", projectId: "project-1" }}
        paneId="topLeft"
      />,
    );

    await waitFor(() => {
      expect(latestEnvironmentSelectorProps?.value).toEqual({
        kind: "project",
        projectId: "project-1",
        target: { kind: "new", baseBranch: "main", name: "feature-chat" },
      });
    });
  });

  it("hydrates the target project draft before applying the chat-to-project local fallback", async () => {
    mockedBridge.listProjectBranches.mockResolvedValueOnce(["release", "main"]);
    mockedBridge.getDraftThreadState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        composerDraft: {
          text: "Persisted project text",
          images: [],
          mentionBindings: [],
          isRefiningPlan: false,
        },
        composer: {
          provider: "codex",
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
          collaborationMode: "plan",
          approvalPolicy: "askToEdit",
          serviceTier: null,
        },
        projectSelection: {
          kind: "new",
          baseBranch: "release",
          name: "persisted-worktree",
        },
      });

    const { rerender } = render(
      <ThreadDraftComposer draft={{ kind: "chat" }} paneId="topLeft" />,
    );

    await act(async () => {
      latestEnvironmentSelectorProps?.onChange({
        kind: "project",
        projectId: "project-1",
        target: { kind: "local" },
      });
      await Promise.resolve();
    });

    rerender(
      <ThreadDraftComposer
        draft={{ kind: "project", projectId: "project-1" }}
        paneId="topLeft"
      />,
    );

    await waitFor(() => {
      expect(latestInlineComposerProps).toMatchObject({
        draft: "Persisted project text",
        composer: { model: "gpt-5.4-mini" },
      });
    });

    expect(latestEnvironmentSelectorProps?.value).toMatchObject({
      kind: "project",
      projectId: "project-1",
      target: {
        kind: "new",
        name: "persisted-worktree",
      },
    });
  });

  it("hydrates persisted draft content and project selection", async () => {
    mockedBridge.getDraftThreadState.mockResolvedValueOnce({
      composerDraft: {
        text: "Persisted text",
        images: [{ type: "image", url: "https://example.com/image.png" }],
        mentionBindings: [],
        isRefiningPlan: false,
      },
      composer: {
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        collaborationMode: "plan",
        approvalPolicy: "askToEdit",
        serviceTier: null,
      },
      projectSelection: {
        kind: "new",
        baseBranch: "main",
        name: "persisted-worktree",
      },
    });

    render(
      <ThreadDraftComposer
        draft={{ kind: "project", projectId: "project-1" }}
        paneId="topLeft"
      />,
    );

    await waitFor(() => {
      expect(latestInlineComposerProps).toMatchObject({
        draft: "Persisted text",
        composer: { model: "gpt-5.4-mini" },
        images: [{ type: "image" }],
      });
    });

    expect(latestEnvironmentSelectorProps?.value).toEqual({
      kind: "project",
      projectId: "project-1",
      target: { kind: "new", baseBranch: "main", name: "persisted-worktree" },
    });
  });

  it("uses the chat workspace catalog target for standalone chat drafts", async () => {
    render(<ThreadDraftComposer draft={{ kind: "chat" }} paneId="topLeft" />);

    await waitFor(() => {
      expect(latestInlineComposerProps).not.toBeNull();
    });

    expect(latestInlineComposerProps?.catalogTarget).toEqual({
      kind: "chatWorkspace",
      provider: "codex",
    });
    expect(latestInlineComposerProps?.fileSearchTarget).toBeNull();
  });

  it("passes the selected chat provider to standalone chat autocomplete", async () => {
    mockedBridge.getDraftThreadState.mockResolvedValueOnce({
      composerDraft: {
        text: "",
        images: [],
        mentionBindings: [],
        isRefiningPlan: false,
      },
      composer: {
        provider: "claude",
        model: "claude-sonnet-4-6",
        reasoningEffort: "high",
        collaborationMode: "build",
        approvalPolicy: "askToEdit",
        serviceTier: null,
      },
      projectSelection: null,
    });

    render(<ThreadDraftComposer draft={{ kind: "chat" }} paneId="topLeft" />);

    await waitFor(() => {
      expect(latestInlineComposerProps?.catalogTarget).toEqual({
        kind: "chatWorkspace",
        provider: "claude",
      });
    });
    expect(latestInlineComposerProps?.fileSearchTarget).toBeNull();
  });

  it("keeps environment-backed autocomplete available for new worktree drafts", async () => {
    render(
      <ThreadDraftComposer
        draft={{ kind: "project", projectId: "project-1" }}
        paneId="topLeft"
      />,
    );

    act(() => {
      latestEnvironmentSelectorProps?.onChange({
        kind: "project",
        projectId: "project-1",
        target: { kind: "new", baseBranch: "main", name: "feature-chat" },
      });
    });

    await waitFor(() => {
      expect(latestInlineComposerProps?.catalogTarget).toEqual({
        kind: "environment",
        environmentId: "env-local",
        provider: "codex",
      });
    });
    expect(latestInlineComposerProps?.fileSearchTarget).toEqual({
      kind: "environment",
      environmentId: "env-local",
      provider: "codex",
    });
    expect(latestInlineComposerProps?.transportEnabled).toBe(false);
  });

  it("passes the selected draft provider to environment-backed composer targets", async () => {
    mockedBridge.getDraftThreadState.mockResolvedValueOnce({
      composerDraft: {
        text: "",
        images: [],
        mentionBindings: [],
        isRefiningPlan: false,
      },
      composer: {
        provider: "claude",
        model: "claude-sonnet-4-6",
        reasoningEffort: "high",
        collaborationMode: "build",
        approvalPolicy: "askToEdit",
        serviceTier: null,
      },
      projectSelection: null,
    });

    render(
      <ThreadDraftComposer
        draft={{ kind: "project", projectId: "project-1" }}
        paneId="topLeft"
      />,
    );

    await waitFor(() => {
      expect(latestInlineComposerProps?.catalogTarget).toEqual({
        kind: "environment",
        environmentId: "env-local",
        provider: "claude",
      });
    });
    expect(latestInlineComposerProps?.fileSearchTarget).toEqual({
      kind: "environment",
      environmentId: "env-local",
      provider: "claude",
    });
  });
});
