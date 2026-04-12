import { useEffect, useState } from "react";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
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
import { ChevronRightIcon, GitBranchIcon, PlusIcon } from "../../shared/Icons";
import type {
  EnvironmentRecord,
  EnvironmentPullRequestSnapshot,
  ProjectRecord,
  ThreadConversationSnapshot,
} from "../../lib/types";
import { SidebarUsagePanel } from "./SidebarUsagePanel";
import { SidebarUtilityActions } from "./SidebarUtilityActions";
import type { Theme } from "./StudioShell";
import { createManagedWorktreeForSelection } from "./studioActions";
import {
  environmentItemClassName,
  projectGroupClassName,
  useTreeSidebarReorder,
} from "./useTreeSidebarReorder";
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
  "Delete this project's worktrees before removing it from Loom.";
const PROJECT_REMOVAL_DIALOG_TITLE = "Remove project";

export function TreeSidebar({ theme, onOpenSettings, onToggleTheme }: Props) {
  const projects = useWorkspaceStore(selectProjects);
  const selectedProjectId = useWorkspaceStore((s) => s.selectedProjectId);
  const selectedEnvironmentId = useWorkspaceStore(
    (s) => s.selectedEnvironmentId,
  );
  const refreshSnapshot = useWorkspaceStore((s) => s.refreshSnapshot);
  const reorderProjects = useWorkspaceStore((s) => s.reorderProjects);
  const reorderWorktreeEnvironments = useWorkspaceStore(
    (s) => s.reorderWorktreeEnvironments,
  );
  const setProjectSidebarCollapsed = useWorkspaceStore(
    (s) => s.setProjectSidebarCollapsed,
  );
  const selectProject = useWorkspaceStore((s) => s.selectProject);
  const selectEnvironment = useWorkspaceStore((s) => s.selectEnvironment);
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
  const {
    dragState,
    orderedProjects,
    orderedWorktreeEnvironments,
    registerProjectItem,
    registerEnvironmentItem,
    handleProjectPointerDown,
    handleWorktreePointerDown,
    handleProjectKeyboardReorder,
    handleWorktreeKeyboardReorder,
    projectDragStyle,
    environmentDragStyle,
    shouldSuppressClick,
  } = useTreeSidebarReorder({
    projects,
    reorderProjects,
    reorderWorktreeEnvironments,
    resetMessages,
    setActionError,
  });

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
      `Remove "${projectName}" from Loom? The repository stays on disk. Loom may also remove its empty managed worktree folder.`,
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
      selectProject(projectId);
      await createManagedWorktreeForSelection();
    } catch (cause: unknown) {
      setActionError(actionErrorMessage(cause, "Failed to create worktree"));
    } finally {
      setCreatingWorktreeProjectId(null);
    }
  }

  async function handleProjectCollapseToggle(project: ProjectRecord) {
    resetMessages();
    const result = await setProjectSidebarCollapsed(
      project.id,
      !project.sidebarCollapsed,
    );
    if (!result.ok) {
      setActionError("Failed to update project collapse state");
    } else if (result.warningMessage) {
      setActionError(result.warningMessage);
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
        <div className="tree-sidebar__project-list">
          {notice && <p className="tree-sidebar__notice">{notice}</p>}
          {latestScriptFailure ? (
            <div className="tree-sidebar__notice tree-sidebar__notice--warning">
              <div className="tree-sidebar__notice-copy">
                <strong>
                  {latestScriptFailure.trigger === "setup"
                    ? "Setup"
                    : "Teardown"}{" "}
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
            orderedProjects.map((project) => (
              <section
                key={project.id}
                ref={registerProjectItem(project.id)}
                className={projectGroupClassName(
                  project,
                  selectedProjectId,
                  dragState,
                )}
                style={projectDragStyle(project.id)}
              >
                <div
                  className="project-group__header-shell"
                  onPointerDown={(event) =>
                    handleProjectPointerDown(event, project.id)
                  }
                  onClick={(event) => {
                    if (event.detail > 0 && shouldSuppressClick()) return;
                    handleProjectSelect(project.id);
                  }}
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
                    className="project-group__collapse"
                    data-no-reorder-drag="true"
                    aria-label={`${project.sidebarCollapsed ? "Expand" : "Collapse"} ${project.name}`}
                    aria-expanded={!project.sidebarCollapsed}
                    title={`${project.sidebarCollapsed ? "Expand" : "Collapse"} ${project.name}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void handleProjectCollapseToggle(project);
                    }}
                  >
                    <ChevronRightIcon
                      size={11}
                      className={`project-group__collapse-icon ${
                        project.sidebarCollapsed
                          ? ""
                          : "project-group__collapse-icon--expanded"
                      }`}
                    />
                  </button>
                  <button
                    type="button"
                    className="project-group__header"
                    onKeyDown={(event) =>
                      void handleProjectKeyboardReorder(event, project.id)
                    }
                  >
                    <ProjectIcon
                      name={project.name}
                      rootPath={project.rootPath}
                      size="sm"
                    />
                    <span className="project-group__meta">
                      <span className="project-group__name">{project.name}</span>
                      <ProjectLocalSummary project={project} />
                    </span>
                  </button>
                  <button
                    type="button"
                    className="project-group__create"
                    data-no-reorder-drag="true"
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
                {!project.sidebarCollapsed && (
                  <div className="project-group__environments">
                    {orderedWorktreeEnvironments(project).map((environment) => (
                      <div
                        key={environment.id}
                        ref={registerEnvironmentItem(project.id, environment.id)}
                        className={environmentItemClassName(
                          environment,
                          selectedEnvironmentId,
                          dragState,
                        )}
                        style={environmentDragStyle(project.id, environment.id)}
                        onPointerDown={(event) =>
                          handleWorktreePointerDown(
                            event,
                            project,
                            environment.id,
                          )
                        }
                        onClick={(event) => {
                          if (event.detail > 0 && shouldSuppressClick()) return;
                          handleEnvironmentSelect(environment.id);
                        }}
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
                        <span className="environment-item__icon-slot">
                          {renderPullRequestControl(environment)}
                        </span>
                        <button
                          type="button"
                          className="environment-item"
                          onKeyDown={(event) =>
                            void handleWorktreeKeyboardReorder(
                              event,
                              project,
                              environment.id,
                            )
                          }
                        >
                          <span className="environment-item__primary">
                            <span className="environment-item__name-row">
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
                            <EnvironmentConversationIndicator
                              environment={environment}
                            />
                          </span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ))
          )}
        </div>
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
                Remove from Loom
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

function ProjectLocalSummary({
  project,
}: {
  project: {
    environments: EnvironmentRecord[];
  };
}) {
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
      <EnvironmentConversationIndicator environment={environment} />
    </span>
  );
}

function EnvironmentConversationIndicator({
  environment,
}: {
  environment: EnvironmentRecord;
}) {
  const tone = useConversationStore(selectEnvironmentIndicatorTone(environment));
  return <RuntimeIndicator tone={tone} />;
}

function selectEnvironmentIndicatorTone(environment: EnvironmentRecord) {
  return (state: {
    snapshotsByThreadId: Record<string, ThreadConversationSnapshot>;
  }) =>
    indicatorToneForConversationStatus(
      deriveEnvironmentConversationStatus(environment, state.snapshotsByThreadId),
    );
}

function renderPullRequestControl(environment: EnvironmentRecord) {
  const pullRequest = environment.pullRequest;
  if (!pullRequest) {
    return (
      <span className="environment-item__icon-shell" aria-hidden="true">
        <GitBranchIcon size={13} className="environment-item__icon" />
      </span>
    );
  }

  const label = pullRequestAriaLabel(pullRequest);

  return (
    <button
      type="button"
      className="environment-item__icon-button"
      data-no-reorder-drag="true"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void Promise.resolve(openUrl(pullRequest.url)).catch(() => undefined);
      }}
    >
      <GitBranchIcon
        size={13}
        className={`environment-item__icon environment-item__icon--${pullRequest.state}`}
      />
    </button>
  );
}

function pullRequestAriaLabel(pullRequest: EnvironmentPullRequestSnapshot) {
  const stateLabel =
    pullRequest.state === "merged"
      ? "Merged pull request"
      : "Open pull request";
  return `${stateLabel} #${pullRequest.number}: ${pullRequest.title}`;
}

async function showProjectRemovalBlockedDialog(
  cause: unknown,
): Promise<boolean> {
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
