import { useEffect, useRef, useState, type PointerEvent } from "react";

import {
  useWorkspaceStore,
  selectSelectedProject,
  selectSelectedEnvironment,
  selectSettings,
  selectSelectedThread,
  selectProjects,
} from "../../stores/workspace-store";
import { useTerminalStore } from "../../stores/terminal-store";
import { EnvironmentKindBadge } from "../../shared/EnvironmentKindBadge";
import { RuntimeIndicator } from "../../shared/RuntimeIndicator";
import { PanelLeftIcon, PanelRightIcon, TerminalIcon, ThreadIcon } from "../../shared/Icons";
import { Tooltip } from "../../shared/Tooltip";
import { EnvironmentActionControl } from "./EnvironmentActionControl";
import { OpenEnvironmentControl } from "./OpenEnvironmentControl";
import { ThreadTabs } from "./ThreadTabs";
import { ThreadConversation } from "./ThreadConversation";
import { StudioWelcome } from "./StudioWelcome";
import { TerminalPanel } from "./TerminalPanel";
import type { EnvironmentRecord, ProjectRecord } from "../../lib/types";
import type { Theme } from "./StudioShell";
import "./StudioMain.css";

type Props = {
  theme: Theme;
  projectsSidebarOpen: boolean;
  inspectorOpen: boolean;
  composerFocusKey: number;
  approveOrSubmitKey: number;
  onOpenActionCreateDialog: () => void;
  onToggleProjectsSidebar: () => void;
  onToggleInspector: () => void;
};

export function StudioMain({
  theme,
  projectsSidebarOpen,
  inspectorOpen,
  composerFocusKey,
  approveOrSubmitKey,
  onOpenActionCreateDialog,
  onToggleProjectsSidebar,
  onToggleInspector,
}: Props) {
  const projects = useWorkspaceStore(selectProjects);
  const selectedProject = useWorkspaceStore(selectSelectedProject);
  const selectedEnvironment = useWorkspaceStore(selectSelectedEnvironment);
  const selectedThread = useWorkspaceStore(selectSelectedThread);
  const settings = useWorkspaceStore(selectSettings);
  const isThreadView = Boolean(selectedThread && selectedEnvironment);

  const terminalVisible = useTerminalStore((s) => s.visible);
  const terminalHeight = useTerminalStore((s) => s.height);
  const toggleTerminal = useTerminalStore((s) => s.toggleVisible);
  const [terminalDragging, setTerminalDragging] = useState(false);

  // Lazy-mount the terminal panel: stay unmounted until the user opens it the
  // first time, then keep it mounted (toggled via CSS) so PTYs and xterm
  // scrollback survive hide/show cycles.
  const [terminalEverOpened, setTerminalEverOpened] = useState(terminalVisible);
  useEffect(() => {
    if (terminalVisible) setTerminalEverOpened(true);
    else setTerminalDragging(false);
  }, [terminalVisible]);

  let content;
  if (projects.length === 0) {
    content = <StudioWelcome />;
  } else if (selectedThread && selectedEnvironment) {
    content = (
      <ThreadConversation
        environment={selectedEnvironment}
        thread={selectedThread}
        composerFocusKey={composerFocusKey}
        approveOrSubmitKey={approveOrSubmitKey}
      />
    );
  } else if (selectedEnvironment) {
    content = <EnvironmentView environment={selectedEnvironment} />;
  } else if (selectedProject) {
    content = <ProjectView project={selectedProject} />;
  } else {
    content = <OverviewView projects={projects} />;
  }

  return (
    <main className={`studio-main${terminalDragging ? " studio-main--resizing" : ""}`}>
      <div className="studio-main__toolbar">
        <div className="studio-main__toolbar-primary">
          <Tooltip content={projectsSidebarOpen ? "Hide sidebar" : "Show sidebar"} side="bottom">
            <button
              type="button"
              aria-label={projectsSidebarOpen ? "Hide sidebar" : "Show sidebar"}
              className={`studio-main__toggle-sidebar ${projectsSidebarOpen ? "studio-main__toggle-sidebar--active" : ""}`}
              onClick={onToggleProjectsSidebar}
            >
              <PanelLeftIcon size={14} />
            </button>
          </Tooltip>
          <ThreadTabs />
        </div>
        <div className="studio-main__toolbar-actions">
          <EnvironmentActionControl
            environmentId={selectedEnvironment?.id ?? null}
            projectId={selectedProject?.id ?? null}
            actions={selectedProject?.settings.manualActions ?? []}
            onAddAction={onOpenActionCreateDialog}
          />
          <OpenEnvironmentControl
            environmentId={selectedEnvironment?.id ?? null}
            settings={settings}
          />
          <Tooltip content={terminalVisible ? "Hide terminal" : "Show terminal"} side="bottom">
            <button
              type="button"
              aria-label={terminalVisible ? "Hide terminal" : "Show terminal"}
              className={`studio-main__toggle-terminal ${terminalVisible ? "studio-main__toggle-terminal--active" : ""}`}
              onClick={toggleTerminal}
            >
              <TerminalIcon size={14} />
            </button>
          </Tooltip>
          <Tooltip content={inspectorOpen ? "Hide inspector" : "Show inspector"} side="bottom">
            <button
              type="button"
              aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
              className={`studio-main__toggle-inspector ${inspectorOpen ? "studio-main__toggle-inspector--active" : ""}`}
              onClick={onToggleInspector}
            >
              <PanelRightIcon size={14} />
            </button>
          </Tooltip>
        </div>
      </div>
      <div
        className={`studio-main__content ${isThreadView ? "studio-main__content--thread" : ""}`}
      >
        {content}
      </div>
      {terminalVisible && <TerminalResizeHandle onDraggingChange={setTerminalDragging} />}
      {terminalEverOpened && (
        <div
          className={`studio-main__terminal ${terminalVisible ? "" : "studio-main__terminal--hidden"}`}
          style={{ height: terminalVisible ? terminalHeight : undefined }}
          inert={!terminalVisible || undefined}
        >
          <TerminalPanel theme={theme} />
        </div>
      )}
    </main>
  );
}

function TerminalResizeHandle({
  onDraggingChange,
}: {
  onDraggingChange: (dragging: boolean) => void;
}) {
  const startRef = useRef<{ y: number; height: number } | null>(null);

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    startRef.current = null;
    onDraggingChange(false);
  }

  return (
    <div
      className="studio-main__resize-handle"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        startRef.current = {
          y: event.clientY,
          height: useTerminalStore.getState().height,
        };
        onDraggingChange(true);
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
