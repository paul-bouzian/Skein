import { CloseIcon } from "../../shared/Icons";
import { Tooltip } from "../../shared/Tooltip";
import {
  selectFocusedSlot,
  selectIsSplitOpen,
  selectPaneDraft,
  selectPaneEnvironment,
  selectPaneThread,
  useWorkspaceStore,
  type SlotKey,
} from "../../stores/workspace-store";
import { ThreadDraftComposer } from "./draft/ThreadDraftComposer";
import { ThreadConversation } from "./ThreadConversation";

type Props = {
  paneId: SlotKey;
  composerFocusKey: number;
  approveOrSubmitKey: number;
};

export function StudioPane({
  paneId,
  composerFocusKey,
  approveOrSubmitKey,
}: Props) {
  const environment = useWorkspaceStore(selectPaneEnvironment(paneId));
  const thread = useWorkspaceStore(selectPaneThread(paneId));
  const draft = useWorkspaceStore(selectPaneDraft(paneId));
  const focusedSlot = useWorkspaceStore(selectFocusedSlot);
  const isSplit = useWorkspaceStore(selectIsSplitOpen);
  const focusPane = useWorkspaceStore((state) => state.focusPane);
  const closePane = useWorkspaceStore((state) => state.closePane);
  const isFocused = focusedSlot === paneId;

  let content;
  let isThreadView = false;
  let isDraftView = false;
  if (thread && environment) {
    isThreadView = true;
    content = (
      <ThreadConversation
        environment={environment}
        thread={thread}
        composerFocusKey={isFocused ? composerFocusKey : 0}
        approveOrSubmitKey={isFocused ? approveOrSubmitKey : 0}
      />
    );
  } else if (draft) {
    isDraftView = true;
    content = (
      <ThreadDraftComposer
        draft={draft}
        paneId={paneId}
      />
    );
  } else {
    isDraftView = true;
    content = (
      <ThreadDraftComposer
        draft={{ kind: "chat" }}
        paneId={paneId}
      />
    );
  }

  const modifierClasses = [
    "studio-main__pane",
    isThreadView ? "studio-main__pane--thread" : "",
    isDraftView ? "studio-main__pane--draft" : "",
    isSplit ? "studio-main__pane--split" : "",
    isSplit && isFocused ? "studio-main__pane--focused" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section
      className={modifierClasses}
      data-pane-id={paneId}
      onPointerDownCapture={(event) => {
        if (shouldSkipFocusCapture(event, isFocused)) return;
        focusPane(paneId);
      }}
      onFocusCapture={(event) => {
        if (shouldSkipFocusCapture(event, isFocused)) return;
        focusPane(paneId);
      }}
    >
      <div className="studio-main__pane-scroll">{content}</div>
      {isSplit && (
        <div className="studio-main__pane-close-shell">
          <Tooltip content="Close pane" side="bottom">
            <button
              type="button"
              aria-label="Close pane"
              className="studio-main__pane-close"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                closePane(paneId);
              }}
            >
              <CloseIcon size={12} />
            </button>
          </Tooltip>
        </div>
      )}
    </section>
  );
}

// Skip focus capture when the event targets a close affordance — otherwise
// we'd retarget focus onto the pane for a single frame before it gets closed.
function shouldSkipFocusCapture(
  event: React.SyntheticEvent,
  isFocused: boolean,
): boolean {
  if (isFocused) return true;
  if (!(event.target instanceof Element)) return false;
  return Boolean(event.target.closest(".studio-main__pane-close"));
}
