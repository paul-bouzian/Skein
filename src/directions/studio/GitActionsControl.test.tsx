import { describe, expect, it } from "vitest";

import { makeGitReviewSnapshot } from "../../test/fixtures/conversation";
import { buildGitActionMenu, resolveQuickGitAction } from "./GitActionsControl.logic";

function snapshotWithSummary(
  summary: Partial<ReturnType<typeof makeGitReviewSnapshot>["summary"]>,
) {
  const base = makeGitReviewSnapshot();
  return {
    ...base,
    summary: {
      ...base.summary,
      ...summary,
    },
  };
}

describe("resolveQuickGitAction", () => {
  it("waits for Git status before enabling actions", () => {
    expect(resolveQuickGitAction(null, true, false, false)).toMatchObject({
      label: "Commit",
      action: null,
      disabled: true,
    });
  });

  it("pulls clean branches that are behind", () => {
    const snapshot = snapshotWithSummary({ dirty: false, ahead: 0, behind: 2 });

    expect(resolveQuickGitAction(snapshot, true, false, false)).toMatchObject({
      label: "Pull",
      action: "pull",
      disabled: false,
    });
  });

  it("does not offer pull when a clean branch has diverged", () => {
    const snapshot = snapshotWithSummary({ dirty: false, ahead: 1, behind: 2 });

    expect(resolveQuickGitAction(snapshot, true, false, false)).toMatchObject({
      label: "Pull",
      action: null,
      disabled: true,
    });
  });

  it("commits dirty branches that are behind before any push action", () => {
    const snapshot = snapshotWithSummary({
      branch: "feature/right-panel",
      baseBranch: "origin/main",
      dirty: true,
      ahead: 0,
      behind: 2,
    });

    expect(resolveQuickGitAction(snapshot, true, false, false)).toMatchObject({
      label: "Commit",
      action: "commit",
      disabled: false,
    });
  });

  it("commits and pushes dirty default branches", () => {
    const snapshot = snapshotWithSummary({
      branch: "main",
      baseBranch: "origin/main",
      dirty: true,
      ahead: 0,
      behind: 0,
    });

    expect(resolveQuickGitAction(snapshot, true, false, false)).toMatchObject({
      label: "Commit & push",
      action: "commitPush",
      disabled: false,
    });
  });

  it("creates a PR for dirty feature branches", () => {
    const snapshot = snapshotWithSummary({
      branch: "feature/right-panel",
      baseBranch: "origin/main",
      dirty: true,
      ahead: 0,
      behind: 0,
    });

    expect(resolveQuickGitAction(snapshot, true, false, false)).toMatchObject({
      label: "Create PR",
      action: "commitPushCreatePr",
      disabled: false,
    });
  });

  it("pushes unpublished commits on an existing PR branch", () => {
    const snapshot = snapshotWithSummary({
      branch: "feature/right-panel",
      dirty: false,
      ahead: 2,
      behind: 0,
    });

    expect(resolveQuickGitAction(snapshot, true, false, true)).toMatchObject({
      label: "Push",
      action: "push",
      disabled: false,
    });
  });

  it("opens existing PRs when the branch is already published", () => {
    const snapshot = snapshotWithSummary({
      branch: "feature/right-panel",
      dirty: false,
      ahead: 0,
      behind: 0,
    });

    expect(resolveQuickGitAction(snapshot, true, false, true)).toMatchObject({
      label: "View PR",
      action: "viewPr",
      disabled: false,
    });
  });

  it("creates a PR from a clean feature branch with local commits", () => {
    const snapshot = snapshotWithSummary({
      branch: "feature/right-panel",
      baseBranch: "origin/main",
      dirty: false,
      ahead: 1,
      behind: 0,
    });

    expect(resolveQuickGitAction(snapshot, true, false, false)).toMatchObject({
      label: "Create PR",
      action: "createPr",
      disabled: false,
    });
  });

  it("does not create a PR from a clean feature branch without commits", () => {
    const snapshot = snapshotWithSummary({
      branch: "feature/right-panel",
      baseBranch: "origin/main",
      dirty: false,
      ahead: 0,
      behind: 0,
    });

    expect(resolveQuickGitAction(snapshot, true, false, false)).toMatchObject({
      label: "Create PR",
      action: null,
      disabled: true,
    });
  });

  it("pushes clean local commits on the default branch", () => {
    const snapshot = snapshotWithSummary({
      branch: "main",
      baseBranch: "origin/main",
      dirty: false,
      ahead: 1,
      behind: 0,
    });

    expect(resolveQuickGitAction(snapshot, true, false, false)).toMatchObject({
      label: "Push",
      action: "push",
      disabled: false,
    });
  });

  it("pushes clean local commits when the default branch tracks a non-origin remote", () => {
    const snapshot = snapshotWithSummary({
      branch: "develop",
      baseBranch: "upstream/develop",
      dirty: false,
      ahead: 1,
      behind: 0,
    });

    expect(resolveQuickGitAction(snapshot, true, false, false)).toMatchObject({
      label: "Push",
      action: "push",
      disabled: false,
    });
  });
});

describe("buildGitActionMenu", () => {
  it("enables commit and push for dirty default branches", () => {
    const snapshot = snapshotWithSummary({
      branch: "main",
      baseBranch: "origin/main",
      dirty: true,
      ahead: 0,
      behind: 0,
    });

    expect(buildGitActionMenu(snapshot, true, false, false)).toContainEqual(
      expect.objectContaining({
        id: "push",
        label: "Commit & push",
        action: "commitPush",
        disabled: false,
        disabledReason: null,
      }),
    );
  });

  it("keeps view PR enabled when an existing PR branch is behind", () => {
    const snapshot = snapshotWithSummary({
      branch: "feature/review",
      baseBranch: "origin/main",
      dirty: false,
      ahead: 0,
      behind: 2,
    });

    expect(buildGitActionMenu(snapshot, true, false, true)).toContainEqual(
      expect.objectContaining({
        id: "pr",
        label: "View PR",
        action: "viewPr",
        disabled: false,
        disabledReason: null,
      }),
    );
  });

  it("disables create PR for clean feature branches without local commits", () => {
    const snapshot = snapshotWithSummary({
      branch: "feature/review",
      baseBranch: "origin/main",
      dirty: false,
      ahead: 0,
      behind: 0,
    });

    expect(buildGitActionMenu(snapshot, true, false, false)).toContainEqual(
      expect.objectContaining({
        id: "pr",
        label: "Create PR",
        action: "createPr",
        disabled: true,
      }),
    );
  });
});
