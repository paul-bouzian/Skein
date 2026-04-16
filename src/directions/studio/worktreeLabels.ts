import type { PullRequestState } from "../../lib/types";

export type WorktreePullRequest = {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
};

export function branchChipLabel(
  branch: string,
  pullRequest?: WorktreePullRequest,
): string {
  if (!pullRequest) {
    return `Worktree: ${branch}`;
  }
  return `${pullRequestStatePrefix(pullRequest.state)} PR #${pullRequest.number}: ${pullRequest.title}`;
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
