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
import { ThreadDraftComposer } from "./ThreadDraftComposer";

let latestEnvironmentSelectorProps: {
  value: unknown;
  onChange: (value: unknown) => void;
} | null = null;
let latestInlineComposerProps: {
  draft: string;
  images: Array<{ type: string }>;
  composer: { model: string };
  modelOptions: Array<{ id: string; displayName: string }>;
  catalogTarget?: unknown;
  fileSearchTarget?: unknown;
  transportEnabled?: boolean;
} | null = null;

vi.mock("../../../lib/bridge", () => ({
  getDraftThreadState: vi.fn(),
  getEnvironmentCapabilities: vi.fn(),
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
  }: {
    composer: { model: string };
    draft: string;
    images: Array<{ type: string }>;
    catalogTarget?: unknown;
    modelOptions: Array<{ id: string; displayName: string }>;
    fileSearchTarget?: unknown;
    transportEnabled?: boolean;
  }) => {
    latestInlineComposerProps = {
      composer,
      draft,
      images,
      modelOptions,
      catalogTarget,
      fileSearchTarget,
      transportEnabled,
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
      expect(screen.getByTestId("inline-composer")).toHaveTextContent(
        "gpt-5.4,gpt-5.4-mini",
      );
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
      });
    });
    expect(latestInlineComposerProps?.fileSearchTarget).toEqual({
      kind: "environment",
      environmentId: "env-local",
    });
    expect(latestInlineComposerProps?.transportEnabled).toBe(false);
  });
});
