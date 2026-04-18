import { memo, type ReactNode } from "react";

import {
  indicatorToneForConversationStatus,
  type ConversationIndicatorTone,
} from "../../lib/conversation-status";
import type {
  PullRequestChecksSnapshot,
  ThreadRecord,
} from "../../lib/types";
import {
  AlertIcon,
  GitBranchIcon,
  PanelRightIcon,
  SpinnerIcon,
} from "../../shared/Icons";
import { Tooltip } from "../../shared/Tooltip";
import { useConversationStore } from "../../stores/conversation-store";
import {
  selectThreadUnread,
  useThreadUnreadStore,
} from "../../stores/thread-unread-store";
import {
  selectThreadInAnyPane,
  selectThreadInFocusedPane,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { useThreadDrag } from "./useThreadDrag";
import {
  branchChipHeaderLabel,
  branchChipLabel,
} from "./worktreeLabels";
import type { WorktreePullRequest } from "./worktreeLabels";

export type ThreadWorktreePullRequest = WorktreePullRequest;

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
  const unread = useThreadUnreadStore(selectThreadUnread(thread.id));
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
  const checks = worktree?.pullRequest?.checks ?? null;
  const tooltipHeader = worktree
    ? branchChipHeaderLabel(worktree.branch, worktree.pullRequest)
    : "";
  const tooltipContent: ReactNode = checks
    ? renderBranchChipTooltip(tooltipHeader, checks)
    : chipLabel;
  const tooltipRepositionKey = checks
    ? buildChecksRepositionKey(checks)
    : chipLabel;

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
        <span
          className="tree-sidebar__thread-indicator"
          aria-hidden="true"
        >
          {renderThreadIndicator(tone, unread)}
        </span>
        {indicatorAccessibleLabel(tone, unread) ? (
          <span className="tree-sidebar__sr-only">
            {indicatorAccessibleLabel(tone, unread)}
          </span>
        ) : null}
        <span className="tree-sidebar__thread-title">{thread.title}</span>
      </button>
      {worktree && onBranchChipContextMenu && onBranchChipOpenPullRequest ? (
        <Tooltip
          content={tooltipContent}
          side="bottom"
          repositionKey={tooltipRepositionKey}
        >
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
            {checks ? (
              <span
                className="tree-sidebar__thread-checks-dot"
                data-checks-state={checks.rollup}
                aria-hidden="true"
              />
            ) : null}
            <GitBranchIcon size={14} className="tree-sidebar__thread-branch-icon" />
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

function renderThreadIndicator(
  tone: ConversationIndicatorTone,
  unread: boolean,
): ReactNode {
  if (tone === "progress") {
    return (
      <SpinnerIcon size={12} className="tree-sidebar__thread-spinner" />
    );
  }
  if (tone === "waiting") {
    return <AlertIcon size={12} className="tree-sidebar__thread-alert" />;
  }
  if (unread) {
    return (
      <span className="tree-sidebar__thread-unread-dot" aria-hidden="true" />
    );
  }
  return null;
}

function indicatorAccessibleLabel(
  tone: ConversationIndicatorTone,
  unread: boolean,
): string | null {
  if (tone === "progress") return "Running";
  if (tone === "waiting") return "Awaiting action";
  if (unread) return "Unread";
  return null;
}

function resolvePaneHint(
  inAnyPane: boolean,
  inFocusedPane: boolean,
): string | undefined {
  if (!inAnyPane) return undefined;
  if (inFocusedPane) return "Open in focused pane";
  return "Open in another pane";
}

const CHECK_ITEMS_IN_TOOLTIP = 8;

function buildChecksRepositionKey(checks: PullRequestChecksSnapshot): string {
  const displayed = checks.items.slice(0, CHECK_ITEMS_IN_TOOLTIP);
  const itemsKey = displayed
    .map((item) => `${item.name}:${item.state}`)
    .join("|");
  return `${checks.rollup}:${checks.total}:${itemsKey}`;
}

function renderBranchChipTooltip(
  headerLabel: string,
  checks: PullRequestChecksSnapshot,
): ReactNode {
  const displayed = checks.items.slice(0, CHECK_ITEMS_IN_TOOLTIP);
  const overflow = checks.total - displayed.length;
  return (
    <span className="branch-chip-tooltip">
      <span className="branch-chip-tooltip__header">{headerLabel}</span>
      {displayed.length > 0 ? (
        <span className="branch-chip-tooltip__items">
          {displayed.map((item, index) => (
            <span key={`${item.name}-${index}`} className="branch-chip-tooltip__item">
              <span
                className="branch-chip-tooltip__item-dot"
                data-checks-state={item.state}
                aria-hidden="true"
              />
              <span className="branch-chip-tooltip__item-name">{item.name}</span>
            </span>
          ))}
          {overflow > 0 ? (
            <span className="branch-chip-tooltip__item branch-chip-tooltip__item--more">
              +{overflow} more
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

