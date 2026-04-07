import { useEffect, useState } from "react";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { createPortal } from "react-dom";
import {
  deriveEnvironmentConversationStatus,
  indicatorToneForConversationStatus,
} from "../../lib/conversation-status";
import {
  useWorkspaceStore,
  selectProjects,
} from "../../stores/workspace-store";
import { useConversationStore } from "../../stores/conversation-store";
import { useWorktreeScriptStore } from "../../stores/worktree-script-store";
import * as bridge from "../../lib/bridge";
import { ProjectIcon } from "../../shared/ProjectIcon";
import { RuntimeIndicator } from "../../shared/RuntimeIndicator";
import { GitBranchIcon, PlusIcon } from "../../shared/Icons";
import type {
  EnvironmentRecord,
  ThreadConversationSnapshot,
} from "../../lib/types";
import { SidebarUsagePanel } from "./SidebarUsagePanel";
import { SidebarUtilityActions } from "./SidebarUtilityActions";
import type { Theme } from "./StudioShell";
import { useProjectImport } from "./useProjectImport";
import "./TreeSidebar.css";

type Props = {
  theme: Theme;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
};

type ContextMenuState = {
  kind: "project" | "environment";
  projectId?: string;
  projectName?: string;
  environmentId?: string;
  environmentName?: string;
  branchName?: string;
  path?: string;
  activeThreadCount?: number;
  archivedThreadCount?: number;
  x: number;
  y: number;
};

const PROJECT_REMOVAL_BLOCKED_MESSAGE =
  "Delete this project's worktrees before removing it from ThreadEx.";
const PROJECT_REMOVAL_DIALOG_TITLE = "Remove project";

export function TreeSidebar({ theme, onOpenSettings, onToggleTheme }: Props) {
  const projects = useWorkspaceStore(selectProjects);
  const snapshotsByThreadId = useConversationStore(
    (state) => state.snapshotsByThreadId,
  );
  const selectedProjectId = useWorkspaceStore((s) => s.selectedProjectId);
  const selectedEnvironmentId = useWorkspaceStore(
    (s) => s.selectedEnvironmentId,
  );
  const refreshSnapshot = useWorkspaceStore((s) => s.refreshSnapshot);
  const selectProject = useWorkspaceStore((s) => s.selectProject);
  const selectEnvironment = useWorkspaceStore((s) => s.selectEnvironment);
  const selectThread = useWorkspaceStore((s) => s.selectThread);
  const latestScriptFailure = useWorktreeScriptStore(
    (state) => state.latestFailure,
  );
  const dismissLatestScriptFailure = useWorktreeScriptStore(
    (state) => state.dismissLatestFailure,
  );
  const { error, clearError, importProject, isImporting } = useProjectImport();
  const [actionError, setActionError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [creatingWorktreeProjectId, setCreatingWorktreeProjectId] = useState<
    string | null
  >(null);
  const notice = actionError ?? error;

  useEffect(() => {
    if (!contextMenu) return undefined;

    function handleDismiss() {
      setContextMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    }

    window.addEventListener("pointerdown", handleDismiss);
    window.addEventListener("blur", handleDismiss);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handleDismiss);
      window.removeEventListener("blur", handleDismiss);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  function resetMessages() {
    clearError();
    setActionError(null);
  }

  function handleProjectSelect(projectId: string) {
    resetMessages();
    selectProject(projectId);
  }

  function handleEnvironmentSelect(environmentId: string) {
    resetMessages();
    selectEnvironment(environmentId);
  }

  async function handleRemoveProject(projectId: string, projectName: string) {
    setContextMenu(null);
    resetMessages();
    try {
      await bridge.ensureProjectCanBeRemoved(projectId);
    } catch (cause: unknown) {
      if (await showProjectRemovalBlockedDialog(cause)) {
        return;
      }
      setActionError(actionErrorMessage(cause, "Failed to remove project"));
      return;
    }

    const approved = await confirm(
      `Remove "${projectName}" from ThreadEx? The repository stays on disk. ThreadEx may also remove its empty managed worktree folder.`,
      {
        title: PROJECT_REMOVAL_DIALOG_TITLE,
        kind: "warning",
      },
    );

    if (!approved) {
      return;
    }

    try {
      await bridge.removeProject(projectId);
      await refreshSnapshot();
    } catch (cause: unknown) {
      if (await showProjectRemovalBlockedDialog(cause)) {
        return;
      }
      setActionError(actionErrorMessage(cause, "Failed to remove project"));
    }
  }

  async function handleCreateManagedWorktree(projectId: string) {
    setCreatingWorktreeProjectId(projectId);
    try {
      resetMessages();
      const result = await bridge.createManagedWorktree(projectId);
      await refreshSnapshot();
      selectThread(result.thread.id);
    } catch (cause: unknown) {
      setActionError(actionErrorMessage(cause, "Failed to create worktree"));
    } finally {
      setCreatingWorktreeProjectId(null);
    }
  }

  async function handleDeleteWorktree(menu: ContextMenuState) {
    if (
      menu.kind !== "environment" ||
      !menu.environmentId ||
      !menu.environmentName
    ) {
      return;
    }

    setContextMenu(null);
    const activeCount = menu.activeThreadCount ?? 0;
    const archivedCount = menu.archivedThreadCount ?? 0;
    const warningLines = [
      `Delete the worktree "${menu.environmentName}"?`,
      "",
      "This permanently deletes:",
      `- ${activeCount} active thread${activeCount === 1 ? "" : "s"}`,
      `- ${archivedCount} archived thread${archivedCount === 1 ? "" : "s"}`,
      menu.branchName ? `- branch ${menu.branchName}` : null,
      menu.path ? `- ${menu.path}` : null,
    ].filter(Boolean);
    const approved = await confirm(warningLines.join("\n"), {
      title: "Delete worktree",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });

    if (!approved) {
      return;
    }

    try {
      resetMessages();
      await bridge.deleteWorktreeEnvironment(menu.environmentId);
      await refreshSnapshot();
    } catch (cause: unknown) {
      setActionError(actionErrorMessage(cause, "Failed to delete worktree"));
    }
  }

  return (
    <aside className="tree-sidebar">
      <div className="tree-sidebar__header">
        <span className="tree-sidebar__title">Projects</span>
        <button
          type="button"
          className="tree-sidebar__add"
          title="Add project"
          onClick={() => {
            resetMessages();
            void importProject();
          }}
          disabled={isImporting}
        >
          <PlusIcon size={14} />
        </button>
      </div>
      <div className="tree-sidebar__scroll">
        {notice && <p className="tree-sidebar__notice">{notice}</p>}
        {latestScriptFailure ? (
          <div className="tree-sidebar__notice tree-sidebar__notice--warning">
            <div className="tree-sidebar__notice-copy">
              <strong>
                {latestScriptFailure.trigger === "setup" ? "Setup" : "Teardown"}{" "}
                script failed for {latestScriptFailure.worktreeName}
              </strong>
              <span>{latestScriptFailure.message}</span>
              <code>{latestScriptFailure.logPath}</code>
            </div>
            <button
              type="button"
              className="tree-sidebar__notice-dismiss"
              onClick={dismissLatestScriptFailure}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {projects.length === 0 ? (
          <p className="tree-sidebar__empty">
            {isImporting ? "Importing project..." : "No projects yet"}
          </p>
        ) : (
          projects.map((project) => (
            <section
              key={project.id}
              className={`project-group ${
                project.id === selectedProjectId
                  ? "project-group--selected"
                  : ""
              }`}
            >
              <div
                className="project-group__header-shell"
                onContextMenu={(event) => {
                  event.preventDefault();
                  handleProjectSelect(project.id);
                  setContextMenu(
                    buildProjectContextMenuState(
                      project.id,
                      project.name,
                      event.clientX,
                      event.clientY,
                    ),
                  );
                }}
              >
                <button
                  type="button"
                  className="project-group__header"
                  onClick={() => handleProjectSelect(project.id)}
                >
                  <ProjectIcon
                    name={project.name}
                    rootPath={project.rootPath}
                    size="sm"
                  />
                  <span className="project-group__meta">
                    <span className="project-group__name">{project.name}</span>
                    {renderProjectLocalSummary(project, snapshotsByThreadId)}
                  </span>
                </button>
                <button
                  type="button"
                  className="project-group__create"
                  aria-label={`Create worktree for ${project.name}`}
                  title={`Create worktree for ${project.name}`}
                  disabled={creatingWorktreeProjectId === project.id}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleCreateManagedWorktree(project.id);
                  }}
                >
                  <PlusIcon
                    size={12}
                    className={
                      creatingWorktreeProjectId === project.id
                        ? "project-group__create-icon project-group__create-icon--spinning"
                        : "project-group__create-icon"
                    }
                  />
                </button>
              </div>
              <div className="project-group__environments">
                {project.environments
                  .filter((environment) => environment.kind !== "local")
                  .map((environment) => (
                    <button
                      key={environment.id}
                      type="button"
                      className={`environment-item ${
                        selectedEnvironmentId === environment.id
                          ? "environment-item--selected"
                          : ""
                      }`}
                      onClick={() => handleEnvironmentSelect(environment.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        handleEnvironmentSelect(environment.id);
                        setContextMenu(
                          buildEnvironmentContextMenuState(
                            environment,
                            event.clientX,
                            event.clientY,
                          ),
                        );
                      }}
                    >
                      <span className="environment-item__primary">
                        <span className="environment-item__name-row">
                          <GitBranchIcon
                            size={13}
                            className="environment-item__icon"
                          />
                          <span className="environment-item__name">
                            {environment.name}
                          </span>
                        </span>
                        {environment.gitBranch &&
                          environment.gitBranch !== environment.name && (
                            <span
                              className="environment-item__branch"
                              title={environment.gitBranch}
                            >
                              {environment.gitBranch}
                            </span>
                          )}
                      </span>
                      <span className="environment-item__secondary">
                        <RuntimeIndicator
                          tone={environmentIndicatorTone(
                            environment,
                            snapshotsByThreadId,
                          )}
                        />
                      </span>
                    </button>
                  ))}
              </div>
            </section>
          ))
        )}
      </div>
      <div className="tree-sidebar__footer">
        <SidebarUsagePanel />
        <SidebarUtilityActions
          theme={theme}
          onOpenSettings={onOpenSettings}
          onToggleTheme={onToggleTheme}
        />
      </div>
      {contextMenu &&
        createPortal(
          <div
            className="tree-sidebar__context-menu"
            style={resolveContextMenuPosition(contextMenu)}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {contextMenu.kind === "project" ? (
              <button
                type="button"
                className="tree-sidebar__context-item tree-sidebar__context-item--danger"
                onClick={() =>
                  void handleRemoveProject(
                    contextMenu.projectId ?? "",
                    contextMenu.projectName ?? "Project",
                  )
                }
              >
                Remove from ThreadEx
              </button>
            ) : (
              <button
                type="button"
                className="tree-sidebar__context-item tree-sidebar__context-item--danger"
                onClick={() => void handleDeleteWorktree(contextMenu)}
              >
                Delete worktree
              </button>
            )}
          </div>,
          document.body,
        )}
    </aside>
  );
}

function renderProjectLocalSummary(
  project: {
    environments: EnvironmentRecord[];
  },
  snapshotsByThreadId: Record<string, ThreadConversationSnapshot>,
) {
  const environment =
    project.environments.find((candidate) => candidate.kind === "local") ??
    project.environments.find((candidate) => candidate.isDefault) ??
    project.environments[0];
  if (!environment) return null;

  return (
    <span className="project-group__summary">
      {environment.gitBranch ? (
        <span className="project-group__branch" title={environment.gitBranch}>
          {environment.gitBranch}
        </span>
      ) : null}
      <RuntimeIndicator
        tone={environmentIndicatorTone(environment, snapshotsByThreadId)}
      />
    </span>
  );
}

function environmentIndicatorTone(
  environment: EnvironmentRecord,
  snapshotsByThreadId: Record<string, ThreadConversationSnapshot>,
) {
  return indicatorToneForConversationStatus(
    deriveEnvironmentConversationStatus(environment, snapshotsByThreadId),
  );
}

async function showProjectRemovalBlockedDialog(cause: unknown): Promise<boolean> {
  const errorMessage = extractErrorMessage(cause);
  if (errorMessage !== PROJECT_REMOVAL_BLOCKED_MESSAGE) {
    return false;
  }

  await message(errorMessage, {
    title: PROJECT_REMOVAL_DIALOG_TITLE,
    kind: "info",
  });
  return true;
}

function extractErrorMessage(cause: unknown): string | null {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    const message = cause.message.trim();
    return message.length > 0 ? message : null;
  }

  if (cause instanceof Error) {
    const message = cause.message.trim();
    return message.length > 0 ? message : null;
  }

  return null;
}

function actionErrorMessage(cause: unknown, fallback: string) {
  return extractErrorMessage(cause) ?? fallback;
}

function buildProjectContextMenuState(
  projectId: string,
  projectName: string,
  x: number,
  y: number,
): ContextMenuState {
  return { kind: "project", projectId, projectName, x, y };
}

function buildEnvironmentContextMenuState(
  environment: EnvironmentRecord,
  x: number,
  y: number,
): ContextMenuState {
  return {
    kind: "environment",
    environmentId: environment.id,
    environmentName: environment.name,
    branchName: environment.gitBranch,
    path: environment.path,
    activeThreadCount: environment.threads.filter(
      (thread) => thread.status === "active",
    ).length,
    archivedThreadCount: environment.threads.filter(
      (thread) => thread.status === "archived",
    ).length,
    x,
    y,
  };
}

function resolveContextMenuPosition(
  contextMenu: Pick<ContextMenuState, "x" | "y">,
) {
  const menuWidth = 220;
  const menuHeight = 56;
  const margin = 12;

  return {
    left: Math.max(
      margin,
      Math.min(contextMenu.x, window.innerWidth - menuWidth - margin),
    ),
    top: Math.max(
      margin,
      Math.min(contextMenu.y, window.innerHeight - menuHeight - margin),
    ),
  };
}
