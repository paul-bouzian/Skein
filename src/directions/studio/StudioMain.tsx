import { useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";

import * as bridge from "../../lib/bridge";
import {
  useWorkspaceStore,
  selectSelectedProject,
  selectSelectedEnvironment,
  selectSelectedThread,
  selectProjects,
} from "../../stores/workspace-store";
import { EnvironmentKindBadge } from "../../shared/EnvironmentKindBadge";
import { RuntimeIndicator } from "../../shared/RuntimeIndicator";
import { PanelRightIcon, TerminalIcon } from "../../shared/Icons";
import {
  MAX_TERMINAL_HEIGHT_RATIO,
  MIN_TERMINAL_HEIGHT_PX,
  selectEnvironmentTerminalUi,
  useTerminalStore,
} from "../../stores/terminal-store";
import { ThreadTabs } from "./ThreadTabs";
import { ThreadConversation } from "./ThreadConversation";
import { StudioWelcome } from "./StudioWelcome";
import { TerminalDock } from "./terminal/TerminalDock";
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
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const terminalUi = useTerminalStore(
    selectEnvironmentTerminalUi(selectedEnvironment?.id ?? null),
  );
  const toggleTerminalPanel = useTerminalStore((state) => state.togglePanel);
  const createTerminal = useTerminalStore((state) => state.createTerminal);
  const closeTerminal = useTerminalStore((state) => state.closeTerminal);
  const setActiveTerminal = useTerminalStore((state) => state.setActiveTerminal);
  const setTerminalHeight = useTerminalStore((state) => state.setHeight);
  const pruneTerminalEnvironments = useTerminalStore((state) => state.pruneEnvironments);
  const isThreadView = Boolean(selectedThread && selectedEnvironment);
  const environmentIds = useMemo(
    () =>
      projects.flatMap((project) =>
        project.environments.map((environment) => environment.id),
      ),
    [projects],
  );

  useEffect(() => {
    pruneTerminalEnvironments(environmentIds);
  }, [environmentIds, pruneTerminalEnvironments]);

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

  function handleToggleTerminal() {
    if (!selectedEnvironment) return;
    toggleTerminalPanel(selectedEnvironment.id);
  }

  function handleCreateTerminal() {
    if (!selectedEnvironment) return;
    createTerminal(selectedEnvironment.id);
  }

  async function handleCloseTerminal(terminalId: string) {
    if (!selectedEnvironment) return;
    closeTerminal(selectedEnvironment.id, terminalId);
    await bridge.closeEnvironmentTerminal({
      environmentId: selectedEnvironment.id,
      terminalId,
    });
  }

  function handleResizeStart(event: ReactMouseEvent<HTMLDivElement>) {
    if (!selectedEnvironment || !bodyRef.current) return;
    event.preventDefault();

    const startY = event.clientY;
    const startHeight = terminalUi.heightPx;
    const bodyHeight = bodyRef.current.getBoundingClientRect().height;
    const maxHeight = Math.max(
      MIN_TERMINAL_HEIGHT_PX,
      Math.floor(bodyHeight * MAX_TERMINAL_HEIGHT_RATIO),
    );

    const handlePointerMove = (moveEvent: MouseEvent) => {
      const deltaY = startY - moveEvent.clientY;
      const nextHeight = Math.min(
        maxHeight,
        Math.max(MIN_TERMINAL_HEIGHT_PX, startHeight + deltaY),
      );
      setTerminalHeight(selectedEnvironment.id, nextHeight);
    };

    const handlePointerUp = () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };

    document.body.style.setProperty("cursor", "row-resize");
    document.body.style.setProperty("user-select", "none");
    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);
  }

  return (
    <main className="studio-main">
      <div className="studio-main__toolbar">
        <div className="studio-main__toolbar-primary">
          <ThreadTabs />
        </div>
        <div className="studio-main__toolbar-actions">
          {selectedEnvironment ? (
            <button
              type="button"
              className={`studio-main__toolbar-button ${terminalUi.open ? "studio-main__toolbar-button--active" : ""}`}
              title={terminalUi.open ? "Hide terminal" : "Show terminal"}
              aria-label={terminalUi.open ? "Hide terminal" : "Show terminal"}
              onClick={handleToggleTerminal}
            >
              <TerminalIcon size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className={`studio-main__toolbar-button ${inspectorOpen ? "studio-main__toolbar-button--active" : ""}`}
            title={inspectorOpen ? "Hide inspector" : "Show inspector"}
            aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
            onClick={onToggleInspector}
          >
            <PanelRightIcon size={14} />
          </button>
        </div>
      </div>
      <div ref={bodyRef} className="studio-main__body">
        <div
          className={`studio-main__content ${isThreadView ? "studio-main__content--thread" : ""}`}
        >
          {content}
        </div>
        {selectedEnvironment && terminalUi.open && terminalUi.tabs.length > 0 ? (
          <TerminalDock
            environment={selectedEnvironment}
            tabs={terminalUi.tabs}
            activeTerminalId={terminalUi.activeTerminalId}
            heightPx={terminalUi.heightPx}
            onResizeStart={handleResizeStart}
            onSelectTerminal={(terminalId) =>
              setActiveTerminal(selectedEnvironment.id, terminalId)
            }
            onCloseTerminal={(terminalId) => {
              void handleCloseTerminal(terminalId);
            }}
            onCreateTerminal={handleCreateTerminal}
          />
        ) : null}
      </div>
    </main>
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
