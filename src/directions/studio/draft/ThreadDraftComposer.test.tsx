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
  modelOptions: Array<{ id: string; displayName: string }>;
  catalogTarget?: unknown;
  fileSearchTarget?: unknown;
  transportEnabled?: boolean;
} | null = null;

vi.mock("../../../lib/bridge", () => ({
  getEnvironmentCapabilities: vi.fn(),
  listProjectBranches: vi.fn(),
}));

vi.mock("../composer/InlineComposer", () => ({
  InlineComposer: (props: {
    modelOptions: Array<{ id: string; displayName: string }>;
    catalogTarget?: unknown;
    fileSearchTarget?: unknown;
    transportEnabled?: boolean;
  }) => {
    latestInlineComposerProps = props;
    return (
      <div data-testid="inline-composer">
        {props.modelOptions.map((model) => model.id).join(",")}
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
    mockedBridge.listProjectBranches.mockResolvedValue(["main"]);
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

    expect(latestEnvironmentSelectorProps).not.toBeNull();
    expect(latestEnvironmentSelectorProps?.value).toEqual({
      kind: "project",
      projectId: "project-1",
      target: { kind: "new", baseBranch: "main", name: "feature-chat" },
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
