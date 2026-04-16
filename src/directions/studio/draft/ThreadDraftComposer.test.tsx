import { render, screen, waitFor } from "@testing-library/react";
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

vi.mock("../../../lib/bridge", () => ({
  getEnvironmentCapabilities: vi.fn(),
  listProjectBranches: vi.fn(),
}));

vi.mock("../composer/InlineComposer", () => ({
  InlineComposer: ({
    modelOptions,
  }: {
    modelOptions: Array<{ id: string; displayName: string }>;
  }) => (
    <div data-testid="inline-composer">
      {modelOptions.map((model) => model.id).join(",")}
    </div>
  ),
}));

vi.mock("./EnvironmentSelector", () => ({
  EnvironmentSelector: () => <div data-testid="env-selector" />,
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
    render(<ThreadDraftComposer projectId="project-1" paneId="topLeft" />);

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
});
