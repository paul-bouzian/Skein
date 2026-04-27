import type { GitAction, GitReviewSnapshot } from "../../lib/types";

type QuickGitAction = {
  label: string;
  action: GitAction | null;
  disabled: boolean;
  disabledReason: string | null;
};

export type MenuGitAction = {
  id: "commit" | "push" | "pr";
  label: string;
  action: GitAction;
  disabled: boolean;
  disabledReason: string | null;
};

export function resolveQuickGitAction(
  snapshot: GitReviewSnapshot | null,
  hasEnvironment: boolean,
  busy: boolean,
  hasOpenPr: boolean,
): QuickGitAction {
  if (!hasEnvironment) {
    return disabledQuickAction("Commit", "Select an environment first.");
  }
  if (busy) {
    return disabledQuickAction("Commit", "Git action in progress.");
  }
  if (!snapshot) {
    return disabledQuickAction("Commit", "Git status is loading.");
  }

  const { summary } = snapshot;
  if (!summary.branch) {
    return disabledQuickAction("Commit", "Checkout a branch before running Git actions.");
  }
  const defaultBranch = isDefaultBranch(summary.branch, summary.baseBranch);
  if (summary.behind > 0 && !summary.dirty) {
    if (summary.ahead === 0) {
      return { label: "Pull", action: "pull", disabled: false, disabledReason: null };
    }
    return disabledQuickAction("Pull", "Pull/rebase before pushing.");
  }
  if (summary.dirty) {
    if (summary.behind > 0) {
      return { label: "Commit", action: "commit", disabled: false, disabledReason: null };
    }
    if (hasOpenPr || defaultBranch) {
      return {
        label: "Commit & push",
        action: "commitPush",
        disabled: false,
        disabledReason: null,
      };
    }
    return {
      label: "Create PR",
      action: "commitPushCreatePr",
      disabled: false,
      disabledReason: null,
    };
  }
  if (hasOpenPr) {
    if (summary.ahead > 0) {
      return { label: "Push", action: "push", disabled: false, disabledReason: null };
    }
    return { label: "View PR", action: "viewPr", disabled: false, disabledReason: null };
  }
  if (summary.ahead > 0) {
    return defaultBranch
      ? { label: "Push", action: "push", disabled: false, disabledReason: null }
      : { label: "Create PR", action: "createPr", disabled: false, disabledReason: null };
  }
  if (!defaultBranch) {
    return disabledQuickAction("Create PR", "No branch commits to create a PR.");
  }
  return disabledQuickAction("Commit", "Branch is clean and up to date.");
}

export function buildGitActionMenu(
  snapshot: GitReviewSnapshot | null,
  hasEnvironment: boolean,
  busy: boolean,
  hasOpenPr: boolean,
): MenuGitAction[] {
  const unavailable = !hasEnvironment || busy || !snapshot;
  const summary = snapshot?.summary ?? null;
  const hasBranch = Boolean(summary?.branch);
  const dirty = Boolean(summary?.dirty);
  const behind = summary?.behind ?? 0;
  const ahead = summary?.ahead ?? 0;
  const defaultBranch = summary?.branch
    ? isDefaultBranch(summary.branch, summary.baseBranch)
    : false;
  const canCommit = !unavailable && dirty && hasBranch;
  const canPush =
    !unavailable &&
    hasBranch &&
    behind === 0 &&
    (defaultBranch ? dirty || ahead > 0 : !dirty && ahead > 0);
  const canCreateOrViewPr = hasOpenPr
    ? !unavailable
    : !unavailable && hasBranch && ahead > 0 && behind === 0 && !defaultBranch;

  return [
    {
      id: "commit",
      label: "Commit",
      action: "commit",
      disabled: !canCommit,
      disabledReason: resolveCommitDisabledReason({ unavailable, dirty, hasBranch }),
    },
    {
      id: "push",
      label: defaultBranch ? "Commit & push" : "Push",
      action: defaultBranch ? "commitPush" : "push",
      disabled: !canPush,
      disabledReason: resolvePushDisabledReason({
        unavailable,
        dirty,
        hasBranch,
        defaultBranch,
        ahead,
        behind,
      }),
    },
    {
      id: "pr",
      label: hasOpenPr ? "View PR" : "Create PR",
      action: hasOpenPr ? "viewPr" : dirty ? "commitPushCreatePr" : "createPr",
      disabled: !canCreateOrViewPr,
      disabledReason: resolvePrDisabledReason(
        unavailable,
        hasBranch,
        hasOpenPr,
        defaultBranch,
        behind,
      ),
    },
  ];
}

export function isDefaultBranch(
  branch: string,
  baseBranch: string | null | undefined,
) {
  const base = normalizeBaseBranch(baseBranch);
  return branch === "main" || branch === "master" || (base ? branch === base : false);
}

function normalizeBaseBranch(baseBranch: string | null | undefined) {
  const base = baseBranch?.trim();
  if (!base) return null;
  const refsRemote = base.match(/^refs\/remotes\/[^/]+\/(.+)$/);
  if (refsRemote) return refsRemote[1];
  const remoteBranch = base.match(/^[^/]+\/(.+)$/);
  return remoteBranch ? remoteBranch[1] : base;
}

function disabledQuickAction(label: string, reason: string): QuickGitAction {
  return { label, action: null, disabled: true, disabledReason: reason };
}

function resolveCommitDisabledReason({
  unavailable,
  dirty,
  hasBranch,
}: {
  unavailable: boolean;
  dirty: boolean;
  hasBranch: boolean;
}) {
  if (unavailable) return "Git status is unavailable.";
  if (!hasBranch) return "Checkout a branch before running Git actions.";
  return dirty ? null : "No changes to commit.";
}

function resolvePushDisabledReason({
  unavailable,
  dirty,
  hasBranch,
  defaultBranch,
  ahead,
  behind,
}: {
  unavailable: boolean;
  dirty: boolean;
  hasBranch: boolean;
  defaultBranch: boolean;
  ahead: number;
  behind: number;
}) {
  if (unavailable) return "Git status is unavailable.";
  if (!hasBranch) return "Checkout a branch before running Git actions.";
  if (behind > 0) return "Pull/rebase before pushing.";
  if (defaultBranch) {
    return dirty || ahead > 0 ? null : "No local commits or changes to push.";
  }
  if (dirty) return "Commit local changes before pushing.";
  return ahead > 0 ? null : "No local commits to push.";
}

function resolvePrDisabledReason(
  unavailable: boolean,
  hasBranch: boolean,
  hasOpenPr: boolean,
  defaultBranch: boolean,
  behind: number,
) {
  if (unavailable) return "Git status is unavailable.";
  if (hasOpenPr) return null;
  if (!hasBranch) return "Checkout a branch before running Git actions.";
  if (behind > 0) return "Pull/rebase before creating a PR.";
  if (defaultBranch && !hasOpenPr) return "Create a feature branch before opening a PR.";
  return null;
}
