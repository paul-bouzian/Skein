import { create } from "zustand";

import * as bridge from "../lib/bridge";
import type {
  CommitGitInput,
  GitAction,
  GitActionResult,
  GitChangeSection,
  GitFileChange,
  GitFileDiff,
  GitReviewScope,
  GitReviewSnapshot,
} from "../lib/types";

type GitReviewState = {
  scopeByEnvironmentId: Record<string, GitReviewScope>;
  snapshotsByContext: Record<string, GitReviewSnapshot>;
  selectedFileByContext: Record<string, string | null>;
  diffsByContext: Record<string, Record<string, GitFileDiff>>;
  diffErrorByContext: Record<string, string | null>;
  commitMessageByEnvironmentId: Record<string, string>;
  loadingByContext: Record<string, boolean>;
  reviewRequestIdByContext: Record<string, number>;
  diffLoadingByContext: Record<string, boolean>;
  diffRequestIdByContext: Record<string, number>;
  actionByEnvironmentId: Record<string, string | null>;
  generatingCommitMessageByEnvironmentId: Record<string, boolean>;
  errorByContext: Record<string, string | null>;

  loadReview: (environmentId: string, scope?: GitReviewScope) => Promise<void>;
  refreshReview: (environmentId: string) => Promise<void>;
  selectScope: (environmentId: string, scope: GitReviewScope) => Promise<void>;
  selectFile: (
    environmentId: string,
    scope: GitReviewScope,
    section: GitChangeSection,
    path: string,
  ) => Promise<void>;
  closeDiff: (environmentId: string, scope?: GitReviewScope) => void;
  clearSelectedFile: (environmentId: string, scope?: GitReviewScope) => void;
  updateCommitMessage: (environmentId: string, message: string) => void;
  generateCommitMessage: (environmentId: string) => Promise<void>;
  stageFile: (environmentId: string, path: string) => Promise<void>;
  stageAll: (environmentId: string) => Promise<void>;
  unstageFile: (environmentId: string, path: string) => Promise<void>;
  unstageAll: (environmentId: string) => Promise<void>;
  revertFile: (
    environmentId: string,
    section: GitChangeSection,
    path: string,
  ) => Promise<void>;
  revertAll: (environmentId: string) => Promise<void>;
  commit: (environmentId: string, message: string) => Promise<void>;
  fetch: (environmentId: string) => Promise<void>;
  pull: (environmentId: string) => Promise<void>;
  push: (environmentId: string) => Promise<void>;
  runAction: (environmentId: string, action: GitAction) => Promise<GitActionResult | null>;
};

type GitReviewSetter = (
  partial:
    | GitReviewState
    | Partial<GitReviewState>
    | ((state: GitReviewState) => GitReviewState | Partial<GitReviewState>),
  replace?: false,
) => void;

const EMPTY_DIFF_COLLECTION: Record<string, GitFileDiff> = {};

export const useGitReviewStore = create<GitReviewState>((set, get) => ({
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

  loadReview: async (environmentId, explicitScope) => {
    const scope = explicitScope ?? get().scopeByEnvironmentId[environmentId] ?? "uncommitted";
    const contextKey = reviewContextKey(environmentId, scope);
    const requestId = nextRequestId(get().reviewRequestIdByContext[contextKey]);
    set((state) => ({
      scopeByEnvironmentId: {
        ...state.scopeByEnvironmentId,
        [environmentId]: scope,
      },
      reviewRequestIdByContext: {
        ...state.reviewRequestIdByContext,
        [contextKey]: requestId,
      },
      loadingByContext: {
        ...state.loadingByContext,
        [contextKey]: true,
      },
      errorByContext: {
        ...state.errorByContext,
        [contextKey]: null,
      },
    }));

    try {
      const snapshot = await bridge.getGitReviewSnapshot({ environmentId, scope });
      await applySnapshot(snapshot, contextKey, requestId, set, get);
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to load Git review";
      set((state) => ({
        ...(state.reviewRequestIdByContext[contextKey] === requestId
          ? {
              loadingByContext: {
                ...state.loadingByContext,
                [contextKey]: false,
              },
              errorByContext: {
                ...state.errorByContext,
                [contextKey]: message,
              },
            }
          : {}),
      }));
    }
  },

  refreshReview: async (environmentId) => {
    await get().loadReview(environmentId);
  },

  selectScope: async (environmentId, scope) => {
    await get().loadReview(environmentId, scope);
  },

  selectFile: async (environmentId, scope, section, path) => {
    const contextKey = reviewContextKey(environmentId, scope);
    const fileKey = changedFileKey(section, path);
    set((state) => ({
      selectedFileByContext: {
        ...state.selectedFileByContext,
        [contextKey]: fileKey,
      },
      diffErrorByContext: {
        ...state.diffErrorByContext,
        [contextKey]: null,
      },
    }));
    await loadDiffBundle(environmentId, scope, section, path, null, set, get);
  },

  closeDiff: (environmentId, explicitScope) => {
    const scope = explicitScope ?? get().scopeByEnvironmentId[environmentId] ?? "uncommitted";
    const contextKey = reviewContextKey(environmentId, scope);
    set((state) => ({
      selectedFileByContext: {
        ...state.selectedFileByContext,
        [contextKey]: null,
      },
      diffRequestIdByContext: {
        ...state.diffRequestIdByContext,
        [contextKey]: nextRequestId(state.diffRequestIdByContext[contextKey]),
      },
    }));
  },

  clearSelectedFile: (environmentId, explicitScope) => {
    const scope = explicitScope ?? get().scopeByEnvironmentId[environmentId] ?? "uncommitted";
    const contextKey = reviewContextKey(environmentId, scope);
    set((state) => ({
      selectedFileByContext: {
        ...state.selectedFileByContext,
        [contextKey]: null,
      },
      diffsByContext: {
        ...state.diffsByContext,
        [contextKey]: {},
      },
      diffErrorByContext: {
        ...state.diffErrorByContext,
        [contextKey]: null,
      },
      diffRequestIdByContext: {
        ...state.diffRequestIdByContext,
        [contextKey]: nextRequestId(state.diffRequestIdByContext[contextKey]),
      },
    }));
  },

  updateCommitMessage: (environmentId, message) =>
    set((state) => ({
      commitMessageByEnvironmentId: {
        ...state.commitMessageByEnvironmentId,
        [environmentId]: message,
      },
    })),

  generateCommitMessage: async (environmentId) => {
    const scope = get().scopeByEnvironmentId[environmentId] ?? "uncommitted";
    const contextKey = reviewContextKey(environmentId, scope);
    set((state) => ({
      generatingCommitMessageByEnvironmentId: {
        ...state.generatingCommitMessageByEnvironmentId,
        [environmentId]: true,
      },
      errorByContext: {
        ...state.errorByContext,
        [contextKey]: null,
      },
    }));
    try {
      const message = await bridge.generateGitCommitMessage(environmentId);
      set((state) => ({
        commitMessageByEnvironmentId: {
          ...state.commitMessageByEnvironmentId,
          [environmentId]: message,
        },
      }));
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to generate a commit message";
      set((state) => ({
        errorByContext: {
          ...state.errorByContext,
          [contextKey]: message,
        },
      }));
    } finally {
      set((state) => ({
        generatingCommitMessageByEnvironmentId: {
          ...state.generatingCommitMessageByEnvironmentId,
          [environmentId]: false,
        },
      }));
    }
  },

  stageFile: async (environmentId, path) => {
    await runReviewMutation(environmentId, "stage-file", (scope) =>
      bridge.stageGitFile({ environmentId, scope, path }), set, get);
  },

  stageAll: async (environmentId) => {
    await runReviewMutation(environmentId, "stage-all", (scope) =>
      bridge.stageGitAll({ environmentId, scope }), set, get);
  },

  unstageFile: async (environmentId, path) => {
    await runReviewMutation(environmentId, "unstage-file", (scope) =>
      bridge.unstageGitFile({ environmentId, scope, path }), set, get);
  },

  unstageAll: async (environmentId) => {
    await runReviewMutation(environmentId, "unstage-all", (scope) =>
      bridge.unstageGitAll({ environmentId, scope }), set, get);
  },

  revertFile: async (environmentId, section, path) => {
    await runReviewMutation(environmentId, "revert-file", (scope) =>
      bridge.revertGitFile({ environmentId, scope, section, path }), set, get);
  },

  revertAll: async (environmentId) => {
    await runReviewMutation(environmentId, "revert-all", (scope) =>
      bridge.revertGitAll({ environmentId, scope }), set, get);
  },

  commit: async (environmentId, message) => {
    const trimmed = message.trim();
    const input: CommitGitInput = {
      environmentId,
      scope: get().scopeByEnvironmentId[environmentId] ?? "uncommitted",
      message: trimmed,
    };
    const committed = await runReviewMutation(
      environmentId,
      "commit",
      () => bridge.commitGit(input),
      set,
      get,
    );
    if (!committed) {
      return;
    }
    set((state) => ({
      commitMessageByEnvironmentId: {
        ...state.commitMessageByEnvironmentId,
        [environmentId]: "",
      },
    }));
  },

  fetch: async (environmentId) => {
    await runReviewMutation(environmentId, "fetch", (scope) =>
      bridge.fetchGit({ environmentId, scope }), set, get);
  },

  pull: async (environmentId) => {
    await runReviewMutation(environmentId, "pull", (scope) =>
      bridge.pullGit({ environmentId, scope }), set, get);
  },

  push: async (environmentId) => {
    await runReviewMutation(environmentId, "push", (scope) =>
      bridge.pushGit({ environmentId, scope }), set, get);
  },

  runAction: async (environmentId, action) => {
    const result = await runGitActionMutation(environmentId, action, set, get);
    return result;
  },
}));

export function selectGitReviewScope(environmentId: string | null) {
  return (state: GitReviewState) =>
    (environmentId ? state.scopeByEnvironmentId[environmentId] : null) ?? "uncommitted";
}

export function selectGitReviewSnapshot(environmentId: string | null, scope: GitReviewScope) {
  return (state: GitReviewState) =>
    (environmentId ? state.snapshotsByContext[reviewContextKey(environmentId, scope)] : null) ??
    null;
}

export function selectGitReviewSelectedFile(
  environmentId: string | null,
  scope: GitReviewScope,
) {
  return (state: GitReviewState) =>
    (environmentId ? state.selectedFileByContext[reviewContextKey(environmentId, scope)] : null) ??
    null;
}

export function selectGitReviewDiffCollection(
  environmentId: string | null,
  scope: GitReviewScope,
) {
  return (state: GitReviewState) =>
    (environmentId ? state.diffsByContext[reviewContextKey(environmentId, scope)] : null) ??
    EMPTY_DIFF_COLLECTION;
}

export function selectGitReviewDiffError(environmentId: string | null, scope: GitReviewScope) {
  return (state: GitReviewState) =>
    (environmentId ? state.diffErrorByContext[reviewContextKey(environmentId, scope)] : null) ??
    null;
}

export function selectGitReviewError(
  environmentId: string | null,
  scope: GitReviewScope,
) {
  return (state: GitReviewState) =>
    (environmentId ? state.errorByContext[reviewContextKey(environmentId, scope)] : null) ??
    null;
}

async function runReviewMutation(
  environmentId: string,
  action: string,
  operation: (scope: GitReviewScope) => Promise<GitReviewSnapshot>,
  set: GitReviewSetter,
  get: () => GitReviewState,
): Promise<boolean> {
  return runSnapshotMutation({
    environmentId,
    action,
    operation,
    snapshotFromResult: (snapshot) => snapshot,
    successFromResult: () => true,
    failureResult: false,
    set,
    get,
  });
}

async function runGitActionMutation(
  environmentId: string,
  action: GitAction,
  set: GitReviewSetter,
  get: () => GitReviewState,
): Promise<GitActionResult | null> {
  return runSnapshotMutation({
    environmentId,
    action,
    operation: (scope) => bridge.runGitAction({ environmentId, scope, action }),
    snapshotFromResult: (result) => result.snapshot,
    errorFromResult: (result) => result.error ?? null,
    successFromResult: (result) => result,
    failureResult: null,
    set,
    get,
  });
}

async function runSnapshotMutation<TResult, TReturn>({
  environmentId,
  action,
  operation,
  snapshotFromResult,
  errorFromResult,
  successFromResult,
  failureResult,
  set,
  get,
}: {
  environmentId: string;
  action: string;
  operation: (scope: GitReviewScope) => Promise<TResult>;
  snapshotFromResult: (result: TResult) => GitReviewSnapshot;
  errorFromResult?: (result: TResult) => string | null;
  successFromResult: (result: TResult) => TReturn;
  failureResult: TReturn;
  set: GitReviewSetter;
  get: () => GitReviewState;
}): Promise<TReturn> {
  const scope = get().scopeByEnvironmentId[environmentId] ?? "uncommitted";
  const contextKey = reviewContextKey(environmentId, scope);
  const requestId = nextRequestId(get().reviewRequestIdByContext[contextKey]);
  set((state) => ({
    actionByEnvironmentId: {
      ...state.actionByEnvironmentId,
      [environmentId]: action,
    },
    reviewRequestIdByContext: {
      ...state.reviewRequestIdByContext,
      [contextKey]: requestId,
    },
    errorByContext: {
      ...state.errorByContext,
      [contextKey]: null,
    },
  }));

  try {
    const result = await operation(scope);
    await applySnapshot(snapshotFromResult(result), contextKey, requestId, set, get);
    const resultError = errorFromResult?.(result) ?? null;
    if (resultError && get().reviewRequestIdByContext[contextKey] === requestId) {
      set((state) => ({
        errorByContext: {
          ...state.errorByContext,
          [contextKey]: resultError,
        },
      }));
    }
    return successFromResult(result);
  } catch (cause: unknown) {
    const message =
      cause instanceof Error ? cause.message : "Git action failed";
    try {
      const snapshot = await bridge.getGitReviewSnapshot({ environmentId, scope });
      await applySnapshot(snapshot, contextKey, requestId, set, get);
    } catch {
      // Preserve the original action error if the follow-up refresh also fails.
    }
    set((state) => ({
      ...(state.reviewRequestIdByContext[contextKey] === requestId
        ? {
            errorByContext: {
              ...state.errorByContext,
              [contextKey]: message,
            },
          }
        : {}),
    }));
    return failureResult;
  } finally {
    set((state) => ({
      actionByEnvironmentId: {
        ...state.actionByEnvironmentId,
        [environmentId]: null,
      },
    }));
  }
}

async function applySnapshot(
  snapshot: GitReviewSnapshot,
  contextKey: string,
  requestId: number,
  set: GitReviewSetter,
  get: () => GitReviewState,
) {
  if (get().reviewRequestIdByContext[contextKey] !== requestId) {
    return;
  }
  const previousFileKey = get().selectedFileByContext[contextKey];
  const nextSelection = findNextSelectedFile(snapshot, previousFileKey);
  const nextDiffRequestId = nextRequestId(get().diffRequestIdByContext[contextKey]);

  set((state) => ({
    scopeByEnvironmentId: state.scopeByEnvironmentId[snapshot.environmentId]
      ? state.scopeByEnvironmentId
      : {
          ...state.scopeByEnvironmentId,
          [snapshot.environmentId]: snapshot.scope,
        },
    snapshotsByContext: {
      ...state.snapshotsByContext,
      [contextKey]: snapshot,
    },
    diffsByContext: {
      ...state.diffsByContext,
      [contextKey]: {},
    },
    diffErrorByContext: {
      ...state.diffErrorByContext,
      [contextKey]: null,
    },
    diffRequestIdByContext: {
      ...state.diffRequestIdByContext,
      [contextKey]: nextDiffRequestId,
    },
    selectedFileByContext: {
      ...state.selectedFileByContext,
      [contextKey]: nextSelection
        ? changedFileKey(nextSelection.section, nextSelection.path)
        : null,
    },
    loadingByContext: {
      ...state.loadingByContext,
      [contextKey]: false,
    },
  }));

  if (nextSelection) {
    await loadDiffBundle(
      snapshot.environmentId,
      snapshot.scope,
      nextSelection.section,
      nextSelection.path,
      nextDiffRequestId,
      set,
      get,
    );
    return;
  }

  set((state) => ({
    diffsByContext: {
      ...state.diffsByContext,
      [contextKey]: {},
    },
    diffErrorByContext: {
      ...state.diffErrorByContext,
      [contextKey]: null,
    },
  }));
}

async function loadDiffBundle(
  environmentId: string,
  scope: GitReviewScope,
  section: GitChangeSection,
  path: string,
  existingRequestId: number | null,
  set: GitReviewSetter,
  get: () => GitReviewState,
) {
  const contextKey = reviewContextKey(environmentId, scope);
  const snapshot = get().snapshotsByContext[contextKey];
  const orderedFiles = orderDiffFiles(snapshot, section, path);

  if (orderedFiles.length === 0) {
    set((state) => ({
      diffsByContext: {
        ...state.diffsByContext,
        [contextKey]: {},
      },
      diffLoadingByContext: {
        ...state.diffLoadingByContext,
        [contextKey]: false,
      },
    }));
    return;
  }

  const requestId = existingRequestId ?? nextRequestId(get().diffRequestIdByContext[contextKey]);
  set((state) => ({
    diffLoadingByContext: {
      ...state.diffLoadingByContext,
      [contextKey]: true,
    },
    diffRequestIdByContext: {
      ...state.diffRequestIdByContext,
      [contextKey]: requestId,
    },
    diffErrorByContext: {
      ...state.diffErrorByContext,
      [contextKey]: null,
    },
  }));

  try {
    const [selectedFile, ...remainingFiles] = orderedFiles;
    if (selectedFile) {
      const loaded = await fetchAndStoreDiff(
        environmentId,
        scope,
        contextKey,
        requestId,
        selectedFile,
        set,
        get,
      );
      if (!loaded) {
        return;
      }
    }

    for (const file of remainingFiles) {
      try {
        const loaded = await fetchAndStoreDiff(
          environmentId,
          scope,
          contextKey,
          requestId,
          file,
          set,
          get,
        );
        if (!loaded) {
          return;
        }
      } catch {
        // Background diff preloads are best-effort; the selected diff path surfaces errors.
      }
    }

    set((state) => ({
      ...(state.diffRequestIdByContext[contextKey] === requestId
        ? {
            diffErrorByContext: {
              ...state.diffErrorByContext,
              [contextKey]: null,
            },
            diffLoadingByContext: {
              ...state.diffLoadingByContext,
              [contextKey]: false,
            },
          }
        : {}),
    }));
  } catch (cause: unknown) {
    const message =
      cause instanceof Error ? cause.message : "Failed to load the file diff";
    set((state) => ({
      ...(state.diffRequestIdByContext[contextKey] === requestId
        ? {
            diffLoadingByContext: {
              ...state.diffLoadingByContext,
              [contextKey]: false,
            },
            diffErrorByContext: {
              ...state.diffErrorByContext,
              [contextKey]: message,
            },
          }
        : {}),
    }));
  }
}

async function fetchAndStoreDiff(
  environmentId: string,
  scope: GitReviewScope,
  contextKey: string,
  requestId: number,
  file: GitFileChange,
  set: GitReviewSetter,
  get: () => GitReviewState,
) {
  const fileKey = changedFileKey(file.section, file.path);
  if (get().diffRequestIdByContext[contextKey] !== requestId) {
    return false;
  }
  if (get().diffsByContext[contextKey]?.[fileKey]) {
    return true;
  }

  const diff = await bridge.getGitFileDiff({
    environmentId,
    scope,
    section: file.section,
    path: file.path,
  });
  if (get().diffRequestIdByContext[contextKey] !== requestId) {
    return false;
  }

  set((state) => ({
    diffsByContext: {
      ...state.diffsByContext,
      [contextKey]: {
        ...(state.diffsByContext[contextKey] ?? {}),
        [fileKey]: diff,
      },
    },
  }));
  return true;
}

function orderDiffFiles(
  snapshot: GitReviewSnapshot | undefined,
  selectedSection: GitChangeSection,
  selectedPath: string,
) {
  const files = snapshot?.sections.flatMap((candidate) => candidate.files) ?? [];
  if (files.length === 0) {
    return [];
  }

  const selectedKey = changedFileKey(selectedSection, selectedPath);
  const selected = files.find(
    (file) => changedFileKey(file.section, file.path) === selectedKey,
  );
  const rest = files.filter(
    (file) => changedFileKey(file.section, file.path) !== selectedKey,
  );

  return selected ? [selected, ...rest] : files;
}

function findNextSelectedFile(
  snapshot: GitReviewSnapshot,
  previousFileKey: string | null | undefined,
): GitFileChange | null {
  const files = snapshot.sections.flatMap((section) => section.files);
  if (files.length === 0 || !previousFileKey) return null;

  const existing = files.find(
    (file) => changedFileKey(file.section, file.path) === previousFileKey,
  );
  if (existing) {
    return existing;
  }

  const previousPath = previousFileKey.split(":").slice(1).join(":");
  if (!previousPath) {
    return null;
  }

  return files.find((file) => file.path === previousPath) ?? null;
}

function reviewContextKey(environmentId: string, scope: GitReviewScope) {
  return `${environmentId}:${scope}`;
}

function changedFileKey(section: GitChangeSection, path: string) {
  return `${section}:${path}`;
}

function nextRequestId(current: number | undefined) {
  return (current ?? 0) + 1;
}
