import { CloseIcon } from "../../shared/Icons";
import { Tooltip } from "../../shared/Tooltip";
import type { ProjectRecord } from "../../lib/types";
import {
  selectFocusedSlot,
  selectIsSplitOpen,
  selectPaneDraft,
  selectPaneEnvironment,
  selectPaneThread,
  selectProjects,
  useWorkspaceStore,
  type SlotKey,
} from "../../stores/workspace-store";
import { StudioWelcome } from "./StudioWelcome";
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
  const closeHandler = isSplit ? () => closePane(paneId) : null;
  if (thread && environment) {
    isThreadView = true;
    content = (
      <ThreadConversation
        environment={environment}
        thread={thread}
        composerFocusKey={isFocused ? composerFocusKey : 0}
        approveOrSubmitKey={isFocused ? approveOrSubmitKey : 0}
        onClosePane={closeHandler}
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
    content = <WorkspaceHomeView />;
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
      {isSplit && !isThreadView && (
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
      )}
    </section>
  );
}

export function DefaultStudioView() {
  return <WorkspaceHomeView />;
}

// Skip focus capture when the event targets a close affordance — otherwise
// we'd retarget focus onto the pane for a single frame before it gets closed.
function shouldSkipFocusCapture(
  event: React.SyntheticEvent,
  isFocused: boolean,
): boolean {
  if (isFocused) return true;
  if (!(event.target instanceof Element)) return false;
  return Boolean(
    event.target.closest(".studio-main__pane-close, .tx-conversation__close"),
  );
}

function OverviewView({ projects }: { projects: ProjectRecord[] }) {
  const selectProject = useWorkspaceStore((s) => s.selectProject);

  return (
    <div className="studio-overview">
      <h2 className="studio-overview__title">Workspace</h2>
      <p className="studio-overview__subtitle">
        {projects.length} project{projects.length !== 1 ? "s" : ""}
      </p>
      <div className="studio-overview__grid">
        {projects.map((p) => {
          const envCount = p.environments.length;
          const threadCount = p.environments.reduce(
            (sum, e) =>
              sum + e.threads.filter((t) => t.status === "active").length,
            0,
          );
          const runningCount = p.environments.filter(
            (e) => e.runtime.state === "running",
          ).length;

          return (
            <button
              key={p.id}
              className="studio-overview__card"
              onClick={() => selectProject(p.id)}
            >
              <h3 className="studio-overview__card-name">{p.name}</h3>
              <span className="studio-overview__card-path">{p.rootPath}</span>
              <div className="studio-overview__card-meta">
                <span>
                  {envCount} env{envCount !== 1 ? "s" : ""}
                </span>
                <span>
                  {threadCount} thread{threadCount !== 1 ? "s" : ""}
                </span>
                {runningCount > 0 && (
                  <span className="studio-overview__card-running">
                    {runningCount} running
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WorkspaceHomeView() {
  const projects = useWorkspaceStore(selectProjects);

  return projects.length === 0 ? (
    <StudioWelcome />
  ) : (
    <OverviewView projects={projects} />
  );
}
