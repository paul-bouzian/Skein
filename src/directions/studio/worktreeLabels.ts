import type {
  PullRequestChecksSnapshot,
  PullRequestState,
} from "../../lib/types";

export type WorktreePullRequest = {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  checks?: PullRequestChecksSnapshot;
};

export function branchChipHeaderLabel(
  branch: string,
  pullRequest?: WorktreePullRequest,
): string {
  if (!pullRequest) {
    return `Worktree: ${branch}`;
  }
  return `${pullRequestStatePrefix(pullRequest.state)} PR #${pullRequest.number}: ${pullRequest.title}`;
}

export function branchChipLabel(
  branch: string,
  pullRequest?: WorktreePullRequest,
): string {
  const base = branchChipHeaderLabel(branch, pullRequest);
  const summary = pullRequest?.checks
    ? checksSummaryText(pullRequest.checks)
    : null;
  return summary ? `${base} — ${summary}` : base;
}

function checksSummaryText(checks: PullRequestChecksSnapshot): string {
  const parts: string[] = [];
  if (checks.passed > 0) parts.push(`${checks.passed} passed`);
  if (checks.pending > 0) parts.push(`${checks.pending} running`);
  if (checks.failed > 0) parts.push(`${checks.failed} failed`);
  const other = Math.max(
    0,
    checks.total - checks.passed - checks.pending - checks.failed,
  );
  if (other > 0) parts.push(`${other} other`);
  if (parts.length === 0) {
    return `${checks.total} check${checks.total === 1 ? "" : "s"}`;
  }
  return parts.join(" • ");
}

function pullRequestStatePrefix(state: PullRequestState): string {
  switch (state) {
    case "merged":
      return "Merged";
    case "closed":
      return "Closed";
    case "open":
      return "Open";
  }
}
