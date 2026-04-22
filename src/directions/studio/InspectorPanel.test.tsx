import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import { dialogConfirmMock } from "../../test/desktop-mock";
import {
  makeConversationSnapshot,
  makeEnvironment,
  makeGitReviewSnapshot,
  makeThread,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { useConversationStore } from "../../stores/conversation-store";
import { useGitReviewStore } from "../../stores/git-review-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { InspectorPanel } from "./InspectorPanel";

vi.mock("../../lib/bridge", () => ({
  getGitReviewSnapshot: vi.fn(),
  getGitFileDiff: vi.fn(),
  stageGitFile: vi.fn(),
  stageGitAll: vi.fn(),
  unstageGitFile: vi.fn(),
  unstageGitAll: vi.fn(),
  revertGitFile: vi.fn(),
  revertGitAll: vi.fn(),
  commitGit: vi.fn(),
  fetchGit: vi.fn(),
  pullGit: vi.fn(),
  pushGit: vi.fn(),
  generateGitCommitMessage: vi.fn(),
}));


const mockedBridge = vi.mocked(bridge);

beforeEach(() => {
  vi.clearAllMocks();
  useGitReviewStore.setState({
    scopeByEnvironmentId: {},
    snapshotsByContext: {},
    selectedFileByContext: {},
    diffsByContext: {},
    diffErrorByContext: {},
    commitMessageByEnvironmentId: {},
    loadingByContext: {},
    diffLoadingByContext: {},
    actionByEnvironmentId: {},
    generatingCommitMessageByEnvironmentId: {},
    errorByContext: {},
  });

  const thread = makeThread();
  const environment = makeEnvironment({ threads: [thread] });
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: makeWorkspaceSnapshot({
      projects: [{ ...makeWorkspaceSnapshot().projects[0], environments: [environment] }],
    }),
    loadingState: "ready",
    selectedProjectId: "project-1",
    selectedEnvironmentId: environment.id,
    selectedThreadId: thread.id,
    error: null,
  }));
  useConversationStore.setState((state) => ({
    ...state,
    snapshotsByThreadId: {
      [thread.id]: makeConversationSnapshot(),
    },
  }));
});

describe("InspectorPanel", () => {
  it("renders the Git review pane for the selected environment", async () => {
    mockedBridge.getGitReviewSnapshot.mockResolvedValue(makeGitReviewSnapshot());

    render(<InspectorPanel />);

    expect(
      await screen.findByRole("group", { name: "Review scope" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("src/app.ts")).toBeInTheDocument();
    expect(screen.queryByText("+const answer = 2;")).not.toBeInTheDocument();
  });

  it("loads Git review for the local environment while the focused pane is a draft", async () => {
    mockedBridge.getGitReviewSnapshot.mockResolvedValue(makeGitReviewSnapshot());
    useWorkspaceStore.setState((state) => ({
      ...state,
      layout: {
        slots: {
          topLeft: null,
          topRight: null,
          bottomLeft: null,
          bottomRight: null,
        },
        focusedSlot: null,
        rowRatio: 0.5,
        colRatio: 0.5,
      },
      draftBySlot: {},
      selectedProjectId: null,
      selectedEnvironmentId: null,
      selectedThreadId: null,
    }));
    useWorkspaceStore.getState().openThreadDraft("project-1");

    render(<InspectorPanel />);

    await screen.findByRole("group", { name: "Review scope" });
    expect(mockedBridge.getGitReviewSnapshot).toHaveBeenCalledWith({
      environmentId: "env-1",
      scope: "uncommitted",
    });
  });

  it("does not load Git review for chat environments", () => {
    const thread = makeThread({
      id: "chat-thread-1",
      environmentId: "chat-env-1",
    });
    const chatEnvironment = makeEnvironment({
      id: "chat-env-1",
      projectId: "skein-chat-workspace",
      name: "Chat",
      kind: "chat",
      path: "/tmp/.skein/chats/chat-env-1",
      gitBranch: undefined,
      baseBranch: undefined,
      isDefault: false,
      pullRequest: undefined,
      threads: [thread],
      runtime: undefined,
    });
    const baseSnapshot = makeWorkspaceSnapshot();
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: {
        ...baseSnapshot,
        chat: {
          ...baseSnapshot.chat,
          environments: [chatEnvironment],
        },
      },
      layout: {
        slots: {
          topLeft: null,
          topRight: null,
          bottomLeft: null,
          bottomRight: null,
        },
        focusedSlot: null,
        rowRatio: 0.5,
        colRatio: 0.5,
      },
      draftBySlot: {},
      selectedProjectId: "skein-chat-workspace",
      selectedEnvironmentId: chatEnvironment.id,
      selectedThreadId: thread.id,
    }));

    render(<InspectorPanel />);

    expect(
      screen.getByText("Select an environment to inspect its Git state."),
    ).toBeInTheDocument();
    expect(mockedBridge.getGitReviewSnapshot).not.toHaveBeenCalled();
  });

  it("confirms before reverting all tracked changes", async () => {
    dialogConfirmMock.mockResolvedValue(false);
    mockedBridge.getGitReviewSnapshot.mockResolvedValue(makeGitReviewSnapshot());

    render(<InspectorPanel />);

    await screen.findByRole("group", { name: "Review scope" });
    await userEvent.click(screen.getByRole("button", { name: "Revert all" }));

    await waitFor(() => {
      expect(dialogConfirmMock).toHaveBeenCalledWith(
        "Are you sure you want to revert all tracked changes?",
        expect.objectContaining({ title: "Revert All Changes" }),
      );
    });
    expect(mockedBridge.revertGitAll).not.toHaveBeenCalled();
  });
});
