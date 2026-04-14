import { EnvironmentKindBadge } from "../../shared/EnvironmentKindBadge";
import { RuntimeIndicator } from "../../shared/RuntimeIndicator";
import { CloseIcon, ThreadIcon } from "../../shared/Icons";
import { Tooltip } from "../../shared/Tooltip";
import type { EnvironmentRecord, ProjectRecord } from "../../lib/types";
import {
  selectFocusedSlot,
  selectIsSplitOpen,
  selectPaneEnvironment,
  selectPaneProject,
  selectPaneThread,
  selectProjects,
  useWorkspaceStore,
  type SlotKey,
} from "../../stores/workspace-store";
import { StudioWelcome } from "./StudioWelcome";
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
  const projects = useWorkspaceStore(selectProjects);
  const project = useWorkspaceStore(selectPaneProject(paneId));
  const environment = useWorkspaceStore(selectPaneEnvironment(paneId));
  const thread = useWorkspaceStore(selectPaneThread(paneId));
  const focusedSlot = useWorkspaceStore(selectFocusedSlot);
  const isSplit = useWorkspaceStore(selectIsSplitOpen);
  const focusPane = useWorkspaceStore((state) => state.focusPane);
  const closePane = useWorkspaceStore((state) => state.closePane);
  const isFocused = focusedSlot === paneId;

  let content;
  let isThreadView = false;
  const closeHandler = isSplit ? () => closePane(paneId) : null;
  if (projects.length === 0) {
    content = <StudioWelcome />;
  } else if (thread && environment) {
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
  } else if (environment) {
    content = <EnvironmentView environment={environment} />;
  } else if (project) {
    content = <ProjectView project={project} />;
  } else {
    content = <OverviewView projects={projects} />;
  }

  const modifierClasses = [
    "studio-main__pane",
    isThreadView ? "studio-main__pane--thread" : "",
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
  const projects = useWorkspaceStore(selectProjects);
  if (projects.length === 0) {
    return <StudioWelcome />;
  }
  return <OverviewView projects={projects} />;
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

function ProjectView({ project }: { project: ProjectRecord }) {
  const selectEnvironment = useWorkspaceStore((s) => s.selectEnvironment);
  const worktrees = project.environments.filter(
    (environment) => environment.kind !== "local",
  );

  return (
    <div className="studio-project-view">
      <div className="studio-project-view__header">
        <h2>{project.name}</h2>
        <span className="studio-project-view__path">{project.rootPath}</span>
      </div>
      <div className="studio-project-view__envs">
        <h3 className="studio-section-label">Worktrees</h3>
        {worktrees.length === 0 ? (
          <p className="studio-env-view__hint">
            No worktrees yet for this project.
          </p>
        ) : null}
        {worktrees.map((env) => (
          <button
            key={env.id}
            className="studio-env-row"
            onClick={() => selectEnvironment(env.id)}
          >
            <div className="studio-env-row__left">
              <EnvironmentKindBadge kind={env.kind} />
              <span className="studio-env-row__name">{env.name}</span>
              {env.gitBranch && (
                <span className="studio-env-row__branch">{env.gitBranch}</span>
              )}
            </div>
            <div className="studio-env-row__right">
              <span className="studio-env-row__threads">
                {env.threads.filter((t) => t.status === "active").length}{" "}
                threads
              </span>
              <RuntimeIndicator state={env.runtime.state} label />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function EnvironmentView({ environment }: { environment: EnvironmentRecord }) {
  return (
    <div className="studio-env-view">
      <div className="studio-env-view__center">
        <div className="studio-env-view__icon-ring">
          <ThreadIcon size={24} />
        </div>
        <h2 className="studio-env-view__name">{environment.name}</h2>
        <div className="studio-env-view__meta">
          <EnvironmentKindBadge kind={environment.kind} />
          <RuntimeIndicator state={environment.runtime.state} label />
          {environment.gitBranch && (
            <span className="studio-env-view__branch-pill">
              {environment.gitBranch}
            </span>
          )}
        </div>
        <p className="studio-env-view__hint">
          Start a new thread to begin working
        </p>
      </div>
    </div>
  );
}
