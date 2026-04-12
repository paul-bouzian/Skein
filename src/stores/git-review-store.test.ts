import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import { makeGitFileDiff, makeGitReviewSnapshot } from "../test/fixtures/conversation";
import { useGitReviewStore } from "./git-review-store";

vi.mock("../lib/bridge", () => ({
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
  vi.useRealTimers();
  useGitReviewStore.setState({
    scopeByEnvironmentId: {},
    snapshotsByContext: {},
    selectedFileByContext: {},
    diffsByContext: {},
    diffErrorByContext: {},
    commitMessageByEnvironmentId: {},
    loadingByContext: {},
    reviewRequestIdByContext: {},
    diffLoadingByContext: {},
    diffRequestIdByContext: {},
    actionByEnvironmentId: {},
    generatingCommitMessageByEnvironmentId: {},
    errorByContext: {},
  });
});

describe("git-review-store", () => {
  it("loads a review snapshot without auto-opening a diff", async () => {
    mockedBridge.getGitReviewSnapshot.mockResolvedValue(makeGitReviewSnapshot());

    await useGitReviewStore.getState().loadReview("env-1");

    const state = useGitReviewStore.getState();
    expect(mockedBridge.getGitReviewSnapshot).toHaveBeenCalledWith({
      environmentId: "env-1",
      scope: "uncommitted",
    });
    expect(state.selectedFileByContext["env-1:uncommitted"]).toBeNull();
    expect(state.diffsByContext["env-1:uncommitted"]).toEqual({});
    expect(mockedBridge.getGitFileDiff).not.toHaveBeenCalled();
  });

  it("switches scope without auto-opening the branch diff", async () => {
    mockedBridge.getGitReviewSnapshot.mockResolvedValue(
      makeGitReviewSnapshot({
        scope: "branch",
        sections: [
          {
            id: "branch",
            label: "Branch changes",
            files: [
              {
                path: "src/feature.ts",
                oldPath: null,
                section: "branch",
                kind: "modified",
                additions: null,
                deletions: null,
                canStage: false,
                canUnstage: false,
                canRevert: false,
              },
            ],
          },
        ],
      }),
    );

    await useGitReviewStore.getState().selectScope("env-1", "branch");

    const state = useGitReviewStore.getState();
    expect(state.scopeByEnvironmentId["env-1"]).toBe("branch");
    expect(state.selectedFileByContext["env-1:branch"]).toBeNull();
    expect(mockedBridge.getGitFileDiff).not.toHaveBeenCalled();
  });

  it("does not let a late snapshot overwrite the selected scope", async () => {
    let resolveUncommitted: ((value: ReturnType<typeof makeGitReviewSnapshot>) => void) | undefined;
    mockedBridge.getGitReviewSnapshot.mockImplementation(({ scope }) => {
      if (scope === "uncommitted") {
        return new Promise((resolve) => {
          resolveUncommitted = resolve as typeof resolveUncommitted;
        });
      }
      return Promise.resolve(makeGitReviewSnapshot({ scope: "branch" }));
    });

    const first = useGitReviewStore.getState().loadReview("env-1");
    await useGitReviewStore.getState().selectScope("env-1", "branch");
    resolveUncommitted?.(makeGitReviewSnapshot({ scope: "uncommitted" }));
    await first;

    expect(useGitReviewStore.getState().scopeByEnvironmentId["env-1"]).toBe("branch");
  });

  it("ignores stale snapshot responses for the same context", async () => {
    let resolveFirst: ((value: ReturnType<typeof makeGitReviewSnapshot>) => void) | undefined;
    mockedBridge.getGitReviewSnapshot.mockImplementation(() => {
      if (!resolveFirst) {
        return new Promise((resolve) => {
          resolveFirst = resolve as typeof resolveFirst;
        });
      }
      return Promise.resolve(
        makeGitReviewSnapshot({
          summary: {
            environmentId: "env-1",
            repoPath: "/tmp/env-1",
            branch: "main",
            baseBranch: "main",
            dirty: true,
            ahead: 2,
            behind: 0,
            hasStagedChanges: false,
            hasUnstagedChanges: true,
            hasUntrackedChanges: false,
          },
        }),
      );
    });

    const first = useGitReviewStore.getState().loadReview("env-1");
    await useGitReviewStore.getState().refreshReview("env-1");
    resolveFirst?.(
      makeGitReviewSnapshot({
        summary: {
          environmentId: "env-1",
          repoPath: "/tmp/env-1",
          branch: "main",
          baseBranch: "main",
          dirty: false,
          ahead: 0,
          behind: 0,
          hasStagedChanges: false,
          hasUnstagedChanges: false,
          hasUntrackedChanges: false,
        },
      }),
    );
    await first;

    expect(
      useGitReviewStore.getState().snapshotsByContext["env-1:uncommitted"]?.summary.ahead,
    ).toBe(2);
  });

  it("keeps stale scope errors out of the active review scope", async () => {
    let rejectUncommitted: ((reason?: unknown) => void) | undefined;
    mockedBridge.getGitReviewSnapshot.mockImplementation(({ scope }) => {
      if (scope === "uncommitted") {
        return new Promise((_, reject) => {
          rejectUncommitted = reject;
        });
      }
      return Promise.resolve(makeGitReviewSnapshot({ scope: "branch" }));
    });

    const first = useGitReviewStore.getState().loadReview("env-1");
    await useGitReviewStore.getState().selectScope("env-1", "branch");
    rejectUncommitted?.(new Error("stale uncommitted failure"));
    await first;

    const state = useGitReviewStore.getState();
    expect(state.errorByContext["env-1:branch"]).toBeNull();
    expect(state.errorByContext["env-1:uncommitted"]).toBe("stale uncommitted failure");
  });

  it("stores a generated commit message per environment", async () => {
    mockedBridge.generateGitCommitMessage.mockResolvedValue("feat: add review pane");

    await useGitReviewStore.getState().generateCommitMessage("env-1");

    expect(useGitReviewStore.getState().commitMessageByEnvironmentId["env-1"]).toBe(
      "feat: add review pane",
    );
  });

  it("keeps the commit message when commit fails", async () => {
    mockedBridge.commitGit.mockRejectedValue(new Error("push rejected"));
    useGitReviewStore.setState({
      scopeByEnvironmentId: { "env-1": "uncommitted" },
      commitMessageByEnvironmentId: { "env-1": "feat: keep me" },
    });

    await useGitReviewStore.getState().commit("env-1", "feat: keep me");

    const state = useGitReviewStore.getState();
    expect(state.commitMessageByEnvironmentId["env-1"]).toBe("feat: keep me");
    expect(state.errorByContext["env-1:uncommitted"]).toBe("push rejected");
  });

  it("keeps the selected file open when it moves between sections", async () => {
    mockedBridge.getGitReviewSnapshot.mockResolvedValue(makeGitReviewSnapshot());
    mockedBridge.getGitFileDiff.mockResolvedValue(makeGitFileDiff());

    await useGitReviewStore.getState().selectFile(
      "env-1",
      "uncommitted",
      "unstaged",
      "src/lib.ts",
    );

    mockedBridge.getGitReviewSnapshot.mockResolvedValue(
      makeGitReviewSnapshot({
        sections: [
          {
            id: "staged",
            label: "Staged",
            files: [
              {
                path: "src/lib.ts",
                oldPath: null,
                section: "staged",
                kind: "added",
                additions: null,
                deletions: null,
                canStage: false,
                canUnstage: true,
                canRevert: true,
              },
            ],
          },
        ],
      }),
    );
    mockedBridge.getGitFileDiff.mockResolvedValue(
      makeGitFileDiff({ section: "staged", path: "src/lib.ts", kind: "added" }),
    );

    await useGitReviewStore.getState().refreshReview("env-1");

    expect(useGitReviewStore.getState().selectedFileByContext["env-1:uncommitted"]).toBe(
      "staged:src/lib.ts",
    );
  });

  it("keeps the latest selected diff when concurrent loads overlap", async () => {
    mockedBridge.getGitReviewSnapshot.mockResolvedValue(
      makeGitReviewSnapshot({
        sections: [
          {
            id: "unstaged",
            label: "Unstaged",
            files: [
              {
                path: "src/a.ts",
                oldPath: null,
                section: "unstaged",
                kind: "modified",
                additions: null,
                deletions: null,
                canStage: true,
                canUnstage: false,
                canRevert: true,
              },
              {
                path: "src/b.ts",
                oldPath: null,
                section: "unstaged",
                kind: "modified",
                additions: null,
                deletions: null,
                canStage: true,
                canUnstage: false,
                canRevert: true,
              },
            ],
          },
        ],
      }),
    );

    const pending = new Map<
      string,
      {
        promise: Promise<ReturnType<typeof makeGitFileDiff>>;
        resolve: (value: ReturnType<typeof makeGitFileDiff>) => void;
      }
    >();
    mockedBridge.getGitFileDiff.mockImplementation(({ path }) => {
      const existing = pending.get(path);
      if (existing) {
        return existing.promise;
      }

      let resolvePromise: ((value: ReturnType<typeof makeGitFileDiff>) => void) | undefined;
      const promise = new Promise<ReturnType<typeof makeGitFileDiff>>((resolve) => {
        resolvePromise = resolve;
      });
      pending.set(path, {
        promise,
        resolve: (value) => resolvePromise?.(value),
      });
      return promise;
    });

    await useGitReviewStore.getState().loadReview("env-1");
    const first = useGitReviewStore
      .getState()
      .selectFile("env-1", "uncommitted", "unstaged", "src/a.ts");
    const second = useGitReviewStore
      .getState()
      .selectFile("env-1", "uncommitted", "unstaged", "src/b.ts");

    pending.get("src/b.ts")?.resolve(makeGitFileDiff({ path: "src/b.ts" }));
    pending.get("src/a.ts")?.resolve(makeGitFileDiff({ path: "src/a.ts" }));
    await Promise.all([first, second]);

    expect(
      useGitReviewStore.getState().selectedFileByContext["env-1:uncommitted"],
    ).toBe("unstaged:src/b.ts");
    expect(useGitReviewStore.getState().diffsByContext["env-1:uncommitted"]).toMatchObject({
      "unstaged:src/b.ts": expect.objectContaining({ path: "src/b.ts" }),
    });
  });

  it("keeps loading true until the latest diff bundle settles", async () => {
    mockedBridge.getGitReviewSnapshot.mockResolvedValue(
      makeGitReviewSnapshot({
        sections: [
          {
            id: "unstaged",
            label: "Unstaged",
            files: [
              {
                path: "src/a.ts",
                oldPath: null,
                section: "unstaged",
                kind: "modified",
                additions: null,
                deletions: null,
                canStage: true,
                canUnstage: false,
                canRevert: true,
              },
            ],
          },
        ],
      }),
    );

    const resolvers: Array<(value: ReturnType<typeof makeGitFileDiff>) => void> = [];
    mockedBridge.getGitFileDiff.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve as (value: ReturnType<typeof makeGitFileDiff>) => void);
        }),
    );

    await useGitReviewStore.getState().loadReview("env-1");
    const first = useGitReviewStore
      .getState()
      .selectFile("env-1", "uncommitted", "unstaged", "src/a.ts");
    const second = useGitReviewStore
      .getState()
      .selectFile("env-1", "uncommitted", "unstaged", "src/a.ts");

    resolvers[0]?.(makeGitFileDiff({ path: "src/a.ts" }));
    await Promise.resolve();
    expect(useGitReviewStore.getState().diffLoadingByContext["env-1:uncommitted"]).toBe(true);

    resolvers[1]?.(makeGitFileDiff({ path: "src/a.ts" }));
    await Promise.all([first, second]);
    expect(useGitReviewStore.getState().diffLoadingByContext["env-1:uncommitted"]).toBe(false);
  });

  it("invalidates cached diffs when a fresh snapshot lands", async () => {
    mockedBridge.getGitReviewSnapshot.mockResolvedValue(makeGitReviewSnapshot());
    mockedBridge.getGitFileDiff.mockResolvedValue(makeGitFileDiff());

    await useGitReviewStore.getState().loadReview("env-1");
    await useGitReviewStore
      .getState()
      .selectFile("env-1", "uncommitted", "unstaged", "src/lib.ts");

    const initialCalls = mockedBridge.getGitFileDiff.mock.calls.length;

    mockedBridge.getGitReviewSnapshot.mockResolvedValue(
      makeGitReviewSnapshot({
        sections: [
          {
            id: "unstaged",
            label: "Unstaged",
            files: [
              {
                path: "src/lib.ts",
                oldPath: null,
                section: "unstaged",
                kind: "modified",
                additions: null,
                deletions: null,
                canStage: true,
                canUnstage: false,
                canRevert: true,
              },
            ],
          },
        ],
      }),
    );

    await useGitReviewStore.getState().refreshReview("env-1");

    expect(mockedBridge.getGitFileDiff.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it("cancels adjacent prefetch when the diff is closed", async () => {
    vi.useFakeTimers();
    mockedBridge.getGitReviewSnapshot.mockResolvedValue(
      makeGitReviewSnapshot({
        sections: [
          {
            id: "unstaged",
            label: "Unstaged",
            files: [
              {
                path: "src/a.ts",
                oldPath: null,
                section: "unstaged",
                kind: "modified",
                additions: null,
                deletions: null,
                canStage: true,
                canUnstage: false,
                canRevert: true,
              },
              {
                path: "src/b.ts",
                oldPath: null,
                section: "unstaged",
                kind: "modified",
                additions: null,
                deletions: null,
                canStage: true,
                canUnstage: false,
                canRevert: true,
              },
            ],
          },
        ],
      }),
    );
    mockedBridge.getGitFileDiff.mockResolvedValue(makeGitFileDiff());

    await useGitReviewStore.getState().loadReview("env-1");
    await useGitReviewStore
      .getState()
      .selectFile("env-1", "uncommitted", "unstaged", "src/a.ts");

    useGitReviewStore.getState().closeDiff("env-1", "uncommitted");
    await vi.advanceTimersByTimeAsync(200);

    expect(mockedBridge.getGitFileDiff).toHaveBeenCalledTimes(1);
  });

  it("cancels adjacent prefetch when the diff is cleared", async () => {
    vi.useFakeTimers();
    mockedBridge.getGitReviewSnapshot.mockResolvedValue(
      makeGitReviewSnapshot({
        sections: [
          {
            id: "unstaged",
            label: "Unstaged",
            files: [
              {
                path: "src/a.ts",
                oldPath: null,
                section: "unstaged",
                kind: "modified",
                additions: null,
                deletions: null,
                canStage: true,
                canUnstage: false,
                canRevert: true,
              },
              {
                path: "src/b.ts",
                oldPath: null,
                section: "unstaged",
                kind: "modified",
                additions: null,
                deletions: null,
                canStage: true,
                canUnstage: false,
                canRevert: true,
              },
            ],
          },
        ],
      }),
    );
    mockedBridge.getGitFileDiff.mockResolvedValue(makeGitFileDiff());

    await useGitReviewStore.getState().loadReview("env-1");
    await useGitReviewStore
      .getState()
      .selectFile("env-1", "uncommitted", "unstaged", "src/a.ts");

    useGitReviewStore.getState().clearSelectedFile("env-1", "uncommitted");
    await vi.advanceTimersByTimeAsync(200);

    expect(mockedBridge.getGitFileDiff).toHaveBeenCalledTimes(1);
  });
});
