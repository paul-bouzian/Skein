import type { GitFileChange } from "../../lib/types";

type GitChangeKindLabelVariant = "compact" | "full";

const GIT_CHANGE_KIND_LABELS: Record<
  GitFileChange["kind"],
  { compact: string; full: string }
> = {
  added: { compact: "A", full: "Added" },
  modified: { compact: "M", full: "Modified" },
  deleted: { compact: "D", full: "Deleted" },
  renamed: { compact: "R", full: "Renamed" },
  copied: { compact: "C", full: "Copied" },
  typeChanged: { compact: "T", full: "Type" },
  unmerged: { compact: "!", full: "Conflict" },
  unknown: { compact: "?", full: "Changed" },
};

export function labelForGitChangeKind(
  kind: GitFileChange["kind"],
  variant: GitChangeKindLabelVariant,
) {
  return GIT_CHANGE_KIND_LABELS[kind][variant];
}
