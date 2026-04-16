export type WorktreePullRequest = {
  number: number;
  title: string;
  url: string;
  state: "open" | "merged" | "closed";
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

function pullRequestStatePrefix(state: WorktreePullRequest["state"]): string {
  switch (state) {
    case "merged":
      return "Merged";
    case "closed":
      return "Closed";
    case "open":
      return "Open";
  }
}
