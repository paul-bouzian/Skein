import { useEffect, useRef, useState, type PointerEvent } from "react";

import {
  useWorkspaceStore,
  selectSelectedProject,
  selectSelectedEnvironment,
  selectSelectedThread,
  selectProjects,
} from "../../stores/workspace-store";
import { useTerminalStore } from "../../stores/terminal-store";
import { EnvironmentKindBadge } from "../../shared/EnvironmentKindBadge";
import { RuntimeIndicator } from "../../shared/RuntimeIndicator";
import { PanelRightIcon, TerminalIcon } from "../../shared/Icons";
import { ThreadTabs } from "./ThreadTabs";
import { ThreadConversation } from "./ThreadConversation";
import { StudioWelcome } from "./StudioWelcome";
import { TerminalPanel } from "./TerminalPanel";
import type { EnvironmentRecord, ProjectRecord } from "../../lib/types";
import "./StudioMain.css";

type Props = {
  inspectorOpen: boolean;
  onToggleInspector: () => void;
};

export function StudioMain({ inspectorOpen, onToggleInspector }: Props) {
  const projects = useWorkspaceStore(selectProjects);
  const selectedProject = useWorkspaceStore(selectSelectedProject);
  const selectedEnvironment = useWorkspaceStore(selectSelectedEnvironment);
  const selectedThread = useWorkspaceStore(selectSelectedThread);
  const isThreadView = Boolean(selectedThread && selectedEnvironment);

  const terminalVisible = useTerminalStore((s) => s.visible);
  const terminalHeight = useTerminalStore((s) => s.height);
  const toggleTerminal = useTerminalStore((s) => s.toggleVisible);

  // Lazy-mount the terminal panel: stay unmounted until the user opens it the
  // first time, then keep it mounted (toggled via CSS) so PTYs and xterm
  // scrollback survive hide/show cycles.
  const [terminalEverOpened, setTerminalEverOpened] = useState(terminalVisible);
  useEffect(() => {
    if (terminalVisible) setTerminalEverOpened(true);
  }, [terminalVisible]);

  let content;
  if (projects.length === 0) {
    content = <StudioWelcome />;
  } else if (selectedThread && selectedEnvironment) {
    content = (
      <ThreadConversation environment={selectedEnvironment} thread={selectedThread} />
    );
  } else if (selectedEnvironment) {
    content = <EnvironmentView environment={selectedEnvironment} />;
  } else if (selectedProject) {
    content = <ProjectView project={selectedProject} />;
  } else {
    content = <OverviewView projects={projects} />;
  }

  return (
    <main className="studio-main">
      <div className="studio-main__toolbar">
        <div className="studio-main__toolbar-primary">
          <ThreadTabs />
        </div>
        <div className="studio-main__toolbar-actions">
          <button
            type="button"
            className={`studio-main__toggle-terminal ${terminalVisible ? "studio-main__toggle-terminal--active" : ""}`}
            title={terminalVisible ? "Hide terminal" : "Show terminal"}
            onClick={toggleTerminal}
          >
            <TerminalIcon size={14} />
          </button>
          <button
            type="button"
            className={`studio-main__toggle-inspector ${inspectorOpen ? "studio-main__toggle-inspector--active" : ""}`}
            title={inspectorOpen ? "Hide inspector" : "Show inspector"}
            onClick={onToggleInspector}
          >
            <PanelRightIcon size={14} />
          </button>
        </div>
      </div>
      <div
        className={`studio-main__content ${isThreadView ? "studio-main__content--thread" : ""}`}
      >
        {content}
      </div>
      {terminalVisible && <TerminalResizeHandle />}
      {terminalEverOpened && (
        <div
          className={`studio-main__terminal ${terminalVisible ? "" : "studio-main__terminal--hidden"}`}
          style={{ height: terminalVisible ? terminalHeight : undefined }}
        >
          <TerminalPanel />
        </div>
      )}
    </main>
  );
}

function TerminalResizeHandle() {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ y: number; height: number } | null>(null);

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    startRef.current = null;
    setDragging(false);
  }

  return (
    <div
      className={`studio-main__resize-handle ${dragging ? "studio-main__resize-handle--dragging" : ""}`}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        startRef.current = {
          y: event.clientY,
          height: useTerminalStore.getState().height,
        };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!startRef.current) return;
        // Drag up => grow terminal; drag down => shrink it.
        const delta = event.clientY - startRef.current.y;
        useTerminalStore
          .getState()
          .setHeight(startRef.current.height - delta);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
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
            (sum, e) => sum + e.threads.filter((t) => t.status === "active").length,
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
                <span>{envCount} env{envCount !== 1 ? "s" : ""}</span>
                <span>{threadCount} thread{threadCount !== 1 ? "s" : ""}</span>
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
  const worktrees = project.environments.filter((environment) => environment.kind !== "local");

  return (
    <div className="studio-project-view">
      <div className="studio-project-view__header">
        <h2>{project.name}</h2>
        <span className="studio-project-view__path">{project.rootPath}</span>
      </div>
      <div className="studio-project-view__envs">
        <h3 className="studio-section-label">Worktrees</h3>
        {worktrees.length === 0 ? (
          <p className="studio-env-view__hint">No worktrees yet for this project.</p>
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
                {env.threads.filter((t) => t.status === "active").length} threads
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
      <div className="studio-env-view__header">
        <EnvironmentKindBadge kind={environment.kind} />
        <h2>{environment.name}</h2>
        <RuntimeIndicator state={environment.runtime.state} size="md" label />
      </div>
      {environment.gitBranch && (
        <p className="studio-env-view__branch">
          Branch: <code>{environment.gitBranch}</code>
          {environment.baseBranch && <> from <code>{environment.baseBranch}</code></>}
        </p>
      )}
      <p className="studio-env-view__hint">
        Create a new thread using the + button in the tab bar above.
      </p>
    </div>
  );
}
