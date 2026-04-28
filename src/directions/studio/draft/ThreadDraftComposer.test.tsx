import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../../lib/bridge";
import type { SavedDraftThreadState } from "../../../lib/types";
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
  disabled?: boolean;
  fileSearchTarget?: unknown;
  isBusy?: boolean;
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
    disabled,
    modelOptions,
    fileSearchTarget,
    isBusy,
    transportEnabled,
    onSend,
  }: {
    composer: { model: string; provider?: string };
    draft: string;
    images: Array<{ type: string }>;
    catalogTarget?: unknown;
    disabled?: boolean;
    modelOptions: Array<{
      id: string;
      displayName: string;
      inputModalities?: string[];
      provider?: string;
    }>;
    fileSearchTarget?: unknown;
    isBusy?: boolean;
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
      disabled,
      fileSearchTarget,
      isBusy,
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

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function makeDraftThreadState(
  overrides: {
    text?: string;
    images?: SavedDraftThreadState["composerDraft"]["images"];
    mentionBindings?: SavedDraftThreadState["composerDraft"]["mentionBindings"];
    isRefiningPlan?: boolean;
    composer?: Partial<SavedDraftThreadState["composer"]>;
    projectSelection?: SavedDraftThreadState["projectSelection"];
  } = {},
): SavedDraftThreadState {
  return {
    composerDraft: {
      text: overrides.text ?? "",
      images: overrides.images ?? [],
      mentionBindings: overrides.mentionBindings ?? [],
      isRefiningPlan: overrides.isRefiningPlan ?? false,
    },
    composer: {
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
      collaborationMode: "build",
      approvalPolicy: "askToEdit",
      serviceTier: null,
      ...overrides.composer,
    },
    projectSelection: overrides.projectSelection ?? null,
  };
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

  it("moves the chat draft into the selected project and clears the chat draft", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      layout: {
        ...state.layout,
        slots: {
          ...state.layout.slots,
          topLeft: {
            projectId: state.snapshot?.chat.projectId ?? null,
            environmentId: null,
            threadId: null,
          },
        },
        focusedSlot: "topLeft",
      },
      draftBySlot: {
        topLeft: { kind: "chat" },
      },
      draftStateByTargetKey: {
        chat: makeDraftThreadState({
          text: "Move this chat draft",
          images: [{ type: "localImage", path: "/tmp/chat-image.png" }],
          mentionBindings: [
            {
              mention: "$skein-standards",
              kind: "skill",
              path: "/skills/skein-standards",
              start: 5,
              end: 21,
            },
          ],
          isRefiningPlan: true,
          composer: {
            model: "gpt-5.4-mini",
            reasoningEffort: "xhigh",
            collaborationMode: "plan",
            approvalPolicy: "fullAccess",
            serviceTier: "fast",
          },
        }),
      },
    }));

    const expectedProjectState = makeDraftThreadState({
      text: "Move this chat draft",
      images: [{ type: "localImage", path: "/tmp/chat-image.png" }],
      mentionBindings: [
        {
          mention: "$skein-standards",
          kind: "skill",
          path: "/skills/skein-standards",
          start: 5,
          end: 21,
        },
      ],
      isRefiningPlan: true,
      composer: {
        model: "gpt-5.4-mini",
        reasoningEffort: "xhigh",
        collaborationMode: "plan",
        approvalPolicy: "fullAccess",
        serviceTier: "fast",
      },
      projectSelection: { kind: "local" },
    });

    render(<ThreadDraftComposer draft={{ kind: "chat" }} paneId="topLeft" />);

    await waitFor(() => {
      expect(latestInlineComposerProps).toMatchObject({
        draft: "Move this chat draft",
        composer: { model: "gpt-5.4-mini" },
        images: [{ type: "localImage" }],
      });
    });

    act(() => {
      latestEnvironmentSelectorProps?.onChange({
        kind: "project",
        projectId: "project-1",
        target: { kind: "local" },
      });
    });

    const state = useWorkspaceStore.getState();
    expect(state.draftStateByTargetKey.chat).toBeUndefined();
    expect(state.draftStateByTargetKey["project:project-1"]).toEqual(
      expectedProjectState,
    );
    expect(useWorkspaceStore.getState().draftBySlot.topLeft).toEqual({
      kind: "project",
      projectId: "project-1",
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedBridge.saveDraftThreadState).toHaveBeenCalledWith({
      target: { kind: "project", projectId: "project-1" },
      state: expectedProjectState,
    });
    expect(mockedBridge.saveDraftThreadState).toHaveBeenCalledWith({
      target: { kind: "chat" },
      state: null,
    });
  });

  it("waits for cold chat draft hydration before moving it into a project", async () => {
    const persistedChatDraft = makeDraftThreadState({
      text: "Persisted chat survives retarget",
      images: [{ type: "localImage", path: "/tmp/persisted-chat.png" }],
      composer: {
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        collaborationMode: "plan",
      },
    });
    const loadedChatDraft = deferred<SavedDraftThreadState | null>();
    mockedBridge.getDraftThreadState.mockReturnValueOnce(loadedChatDraft.promise);
    useWorkspaceStore.setState((state) => ({
      ...state,
      draftBySlot: {
        topLeft: { kind: "chat" },
      },
    }));

    render(<ThreadDraftComposer draft={{ kind: "chat" }} paneId="topLeft" />);

    await waitFor(() => {
      expect(latestEnvironmentSelectorProps).not.toBeNull();
    });

    act(() => {
      latestEnvironmentSelectorProps?.onChange({
        kind: "project",
        projectId: "project-1",
        target: { kind: "local" },
      });
    });

    expect(
      useWorkspaceStore.getState().draftStateByTargetKey["project:project-1"],
    ).toBeUndefined();
    expect(useWorkspaceStore.getState().draftBySlot.topLeft).toEqual({
      kind: "chat",
    });
    expect(mockedBridge.saveDraftThreadState).not.toHaveBeenCalled();

    await act(async () => {
      loadedChatDraft.resolve(persistedChatDraft);
      await Promise.resolve();
      await Promise.resolve();
    });

    const expectedProjectState = makeDraftThreadState({
      text: "Persisted chat survives retarget",
      images: [{ type: "localImage", path: "/tmp/persisted-chat.png" }],
      composer: {
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        collaborationMode: "plan",
      },
      projectSelection: { kind: "local" },
    });

    await waitFor(() => {
      expect(
        useWorkspaceStore.getState().draftStateByTargetKey["project:project-1"],
      ).toEqual(expectedProjectState);
    });
    expect(useWorkspaceStore.getState().draftStateByTargetKey.chat).toBeUndefined();
    expect(useWorkspaceStore.getState().draftBySlot.topLeft).toEqual({
      kind: "project",
      projectId: "project-1",
    });
    expect(mockedBridge.saveDraftThreadState).toHaveBeenCalledWith({
      target: { kind: "project", projectId: "project-1" },
      state: expectedProjectState,
    });
    expect(mockedBridge.saveDraftThreadState).toHaveBeenCalledWith({
      target: { kind: "chat" },
      state: null,
    });
  });

  it("does not retarget the pane when chat hydration resolves after the slot changed", async () => {
    const loadedChatDraft = deferred<SavedDraftThreadState | null>();
    mockedBridge.getDraftThreadState.mockReturnValueOnce(loadedChatDraft.promise);
    useWorkspaceStore.setState((state) => ({
      ...state,
      draftBySlot: {
        topLeft: { kind: "chat" },
      },
    }));

    render(<ThreadDraftComposer draft={{ kind: "chat" }} paneId="topLeft" />);

    await waitFor(() => {
      expect(latestEnvironmentSelectorProps).not.toBeNull();
    });

    act(() => {
      latestEnvironmentSelectorProps?.onChange({
        kind: "project",
        projectId: "project-1",
        target: { kind: "local" },
      });
      useWorkspaceStore.setState((state) => ({
        ...state,
        draftBySlot: {
          topLeft: { kind: "project", projectId: "project-1" },
        },
      }));
    });

    await act(async () => {
      loadedChatDraft.resolve(makeDraftThreadState({ text: "Too late" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useWorkspaceStore.getState().draftStateByTargetKey.chat).toEqual(
      makeDraftThreadState({ text: "Too late" }),
    );
    expect(
      useWorkspaceStore.getState().draftStateByTargetKey["project:project-1"],
    ).toBeUndefined();
    expect(mockedBridge.saveDraftThreadState).not.toHaveBeenCalled();
  });

  it("blocks sends while chat draft retargeting is hydrating", async () => {
    const loadedChatDraft = deferred<SavedDraftThreadState | null>();
    mockedBridge.getDraftThreadState.mockReturnValueOnce(loadedChatDraft.promise);
    useWorkspaceStore.setState((state) => ({
      ...state,
      draftBySlot: {
        topLeft: { kind: "chat" },
      },
    }));

    render(<ThreadDraftComposer draft={{ kind: "chat" }} paneId="topLeft" />);

    await waitFor(() => {
      expect(latestEnvironmentSelectorProps).not.toBeNull();
    });

    act(() => {
      latestEnvironmentSelectorProps?.onChange({
        kind: "project",
        projectId: "project-1",
        target: { kind: "local" },
      });
    });

    await waitFor(() => {
      expect(latestInlineComposerProps).toMatchObject({
        disabled: true,
        isBusy: true,
      });
    });

    act(() => {
      latestInlineComposerProps?.onSend("Do not send yet", [], [], []);
    });

    expect(mockedSendThreadDraft).not.toHaveBeenCalled();

    await act(async () => {
      loadedChatDraft.resolve(makeDraftThreadState({ text: "Move after load" }));
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("replaces the previous project target when moving a chat draft into that project", async () => {
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
    useWorkspaceStore.setState((state) => ({
      ...state,
      draftBySlot: {
        topLeft: { kind: "chat" },
      },
    }));

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
        target: { kind: "local" },
      });
    });
  });

  it("replaces persisted project draft content when moving a chat draft into that project", async () => {
    mockedBridge.listProjectBranches.mockResolvedValueOnce(["release", "main"]);
    mockedBridge.getDraftThreadState.mockResolvedValueOnce(
      makeDraftThreadState({
        text: "Chat text wins",
        images: [{ type: "localImage", path: "/tmp/chat.png" }],
      }),
    );
    useWorkspaceStore.setState((state) => ({
      ...state,
      draftStateByTargetKey: {
        "project:project-1": makeDraftThreadState({
          text: "Persisted project text",
          composer: {
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            collaborationMode: "plan",
          },
          projectSelection: {
            kind: "new",
            baseBranch: "release",
            name: "persisted-worktree",
          },
        }),
      },
    }));

    const { rerender } = render(
      <ThreadDraftComposer draft={{ kind: "chat" }} paneId="topLeft" />,
    );

    await waitFor(() => {
      expect(latestInlineComposerProps?.draft).toBe("Chat text wins");
    });

    useWorkspaceStore.setState((state) => ({
      ...state,
      draftBySlot: {
        topLeft: { kind: "chat" },
      },
    }));

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
        draft: "Chat text wins",
        composer: { model: "gpt-5.4" },
        images: [{ type: "localImage" }],
      });
    });

    expect(latestEnvironmentSelectorProps?.value).toEqual({
      kind: "project",
      projectId: "project-1",
      target: { kind: "local" },
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
