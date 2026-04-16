import { memo } from "react";

import { indicatorToneForConversationStatus } from "../../lib/conversation-status";
import type { ThreadRecord } from "../../lib/types";
import { GitBranchIcon, PanelRightIcon } from "../../shared/Icons";
import { RuntimeIndicator } from "../../shared/RuntimeIndicator";
import { Tooltip } from "../../shared/Tooltip";
import { useConversationStore } from "../../stores/conversation-store";
import {
  selectThreadInAnyPane,
  selectThreadInFocusedPane,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { useThreadDrag } from "./useThreadDrag";

export type ThreadWorktreePullRequest = {
  number: number;
  title: string;
  url: string;
  state: "open" | "merged" | "closed";
};

export type ThreadWorktreeBadge = {
  environmentId: string;
  branch: string;
  pullRequest?: ThreadWorktreePullRequest;
};

type SharedProps = {
  thread: ThreadRecord;
  onSelect: () => void;
  onOpenInOtherPane: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
};

// Keep the worktree chip and its handlers aligned: a chip is only rendered
// for worktree threads, and when it is the context-menu handler must be
// provided — otherwise the chip would have no interactive fallback.
type Props =
  | (SharedProps & {
      worktree?: null;
      onBranchChipContextMenu?: never;
      onBranchChipOpenPullRequest?: never;
    })
  | (SharedProps & {
      worktree: ThreadWorktreeBadge;
      onBranchChipContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
      onBranchChipOpenPullRequest: (url: string) => void;
    });

function SidebarThreadRowImpl(props: Props) {
  const {
    thread,
    onSelect,
    onOpenInOtherPane,
    onContextMenu,
  } = props;
  const worktree = props.worktree ?? null;
  const onBranchChipContextMenu = props.onBranchChipContextMenu;
  const onBranchChipOpenPullRequest = props.onBranchChipOpenPullRequest;
  const tone = useConversationStore((state) =>
    indicatorToneForConversationStatus(
      state.snapshotsByThreadId[thread.id]?.status ?? null,
    ),
  );
  const inAnyPane = useWorkspaceStore(selectThreadInAnyPane(thread.id));
  const inFocusedPane = useWorkspaceStore(selectThreadInFocusedPane(thread.id));
  const dragHandlers = useThreadDrag(thread.id, thread.title, onSelect);

  const classes = [
    "tree-sidebar__thread",
    worktree ? "tree-sidebar__thread--with-worktree" : "",
    inFocusedPane ? "tree-sidebar__thread--active" : "",
    inAnyPane ? "tree-sidebar__thread--in-pane" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const paneHint = resolvePaneHint(inAnyPane, inFocusedPane);
  const chipLabel = worktree
    ? branchChipLabel(worktree.branch, worktree.pullRequest)
    : "";

  return (
    <div className="tree-sidebar__thread-row">
      <button
        type="button"
        className={classes}
        title={paneHint ?? thread.title}
        data-thread-id={thread.id}
        onContextMenu={onContextMenu}
        {...dragHandlers}
      >
        <span className="tree-sidebar__thread-indicator">
          <RuntimeIndicator tone={tone} size="sm" />
        </span>
        <span className="tree-sidebar__thread-title">{thread.title}</span>
      </button>
      {worktree && onBranchChipContextMenu && onBranchChipOpenPullRequest ? (
        <Tooltip content={chipLabel} side="bottom">
          <button
            type="button"
            className="tree-sidebar__thread-branch"
            data-pr-state={worktree.pullRequest?.state ?? "none"}
            aria-label={chipLabel}
            data-no-reorder-drag="true"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const pr = worktree.pullRequest;
              if (pr) {
                onBranchChipOpenPullRequest(pr.url);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onBranchChipContextMenu(event);
            }}
          >
            <GitBranchIcon size={10} className="tree-sidebar__thread-branch-icon" />
            <span className="tree-sidebar__thread-branch-label">
              {worktree.branch}
            </span>
          </button>
        </Tooltip>
      ) : null}
      <Tooltip content="Open in other pane" side="bottom">
        <button
          type="button"
          className="tree-sidebar__thread-split"
          aria-label="Open in other pane"
          onClick={(event) => {
            event.stopPropagation();
            onOpenInOtherPane();
          }}
        >
          <PanelRightIcon size={11} />
        </button>
      </Tooltip>
    </div>
  );
}

export const SidebarThreadRow = memo(SidebarThreadRowImpl);

function resolvePaneHint(
  inAnyPane: boolean,
  inFocusedPane: boolean,
): string | undefined {
  if (!inAnyPane) return undefined;
  if (inFocusedPane) return "Open in focused pane";
  return "Open in another pane";
}

export function branchChipLabel(
  branch: string,
  pullRequest?: ThreadWorktreePullRequest,
): string {
  if (!pullRequest) {
    return `Worktree: ${branch}`;
  }
  return `${pullRequestStatePrefix(pullRequest.state)} PR #${pullRequest.number}: ${pullRequest.title}`;
}

function pullRequestStatePrefix(
  state: ThreadWorktreePullRequest["state"],
): string {
  switch (state) {
    case "merged":
      return "Merged";
    case "closed":
      return "Closed";
    case "open":
      return "Open";
  }
}

