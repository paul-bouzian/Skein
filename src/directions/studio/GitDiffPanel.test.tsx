import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import {
  makeEnvironment,
  makeGitFileDiff,
  makeGitReviewSnapshot,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { useGitReviewStore } from "../../stores/git-review-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { GitDiffPanel } from "./GitDiffPanel";

let currentContextKey = "env-1:uncommitted";

beforeEach(() => {
  const environment = makeEnvironment();
  currentContextKey = `${environment.id}:uncommitted`;
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: makeWorkspaceSnapshot({
      projects: [{ ...makeWorkspaceSnapshot().projects[0], environments: [environment] }],
    }),
    selectedProjectId: "project-1",
    selectedEnvironmentId: environment.id,
    selectedThreadId: environment.threads[0]?.id ?? null,
    loadingState: "ready",
    error: null,
  }));
  useGitReviewStore.setState({
    scopeByEnvironmentId: { [environment.id]: "uncommitted" },
    snapshotsByContext: {
      [currentContextKey]: makeGitReviewSnapshot({ environmentId: environment.id }),
    },
    selectedFileByContext: { [currentContextKey]: "staged:src/app.ts" },
    diffsByContext: {
      [currentContextKey]: {
        "staged:src/app.ts": makeGitFileDiff({ environmentId: environment.id }),
      },
    },
    diffErrorByContext: {},
    commitMessageByEnvironmentId: {},
    loadingByContext: {},
    diffLoadingByContext: {},
    actionByEnvironmentId: {},
    generatingCommitMessageByEnvironmentId: {},
    errorByEnvironmentId: {},
  });
});

describe("GitDiffPanel", () => {
  it("renders the selected diff and lets the user hide it", async () => {
    render(<GitDiffPanel />);

    expect(screen.getByText("Diff")).toBeInTheDocument();
    expect(screen.getByText("+const answer = 2;")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /hide diff/i }));

    expect(useGitReviewStore.getState().selectedFileByContext[currentContextKey]).toBeNull();
    expect(useGitReviewStore.getState().diffsByContext[currentContextKey]).toBeDefined();
  });
});
