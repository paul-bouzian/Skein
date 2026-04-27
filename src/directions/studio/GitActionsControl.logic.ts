import type { GitAction, GitReviewSnapshot } from "../../lib/types";

type QuickGitAction = {
  label: string;
  action: GitAction | null;
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
  if (summary.behind > 0 && !summary.dirty) {
    return { label: "Pull", action: "pull", disabled: false, disabledReason: null };
  }
  if (summary.dirty) {
    if (hasOpenPr || isDefaultBranch(summary.branch, summary.baseBranch)) {
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
  if (summary.ahead > 0 || !isDefaultBranch(summary.branch, summary.baseBranch)) {
    return { label: "Create PR", action: "createPr", disabled: false, disabledReason: null };
  }
  return disabledQuickAction("Commit", "Branch is clean and up to date.");
}

export function isDefaultBranch(
  branch: string,
  baseBranch: string | null | undefined,
) {
  const base = baseBranch?.replace(/^origin\//, "");
  return branch === "main" || branch === "master" || (base ? branch === base : false);
}

function disabledQuickAction(label: string, reason: string): QuickGitAction {
  return { label, action: null, disabled: true, disabledReason: reason };
}
