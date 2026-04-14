import { memo } from "react";

import { indicatorToneForConversationStatus } from "../../lib/conversation-status";
import type { ThreadRecord } from "../../lib/types";
import { PanelRightIcon } from "../../shared/Icons";
import { RuntimeIndicator } from "../../shared/RuntimeIndicator";
import { Tooltip } from "../../shared/Tooltip";
import { useConversationStore } from "../../stores/conversation-store";
import {
  selectThreadInAnyPane,
  selectThreadInFocusedPane,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { useThreadDrag } from "./useThreadDrag";

type Props = {
  thread: ThreadRecord;
  onSelect: () => void;
  onOpenInOtherPane: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
};

function SidebarThreadRowImpl({
  thread,
  onSelect,
  onOpenInOtherPane,
  onContextMenu,
}: Props) {
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
    inFocusedPane ? "tree-sidebar__thread--active" : "",
    inAnyPane ? "tree-sidebar__thread--in-pane" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const paneHint = resolvePaneHint(inAnyPane, inFocusedPane);

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
