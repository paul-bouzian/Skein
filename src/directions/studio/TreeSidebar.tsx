import { useEffect, useState } from "react";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createPortal } from "react-dom";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  deriveEnvironmentConversationStatus,
  indicatorToneForConversationStatus,
} from "../../lib/conversation-status";
import { APP_NAME } from "../../lib/app-identity";
import {
  useWorkspaceStore,
  selectProjects,
} from "../../stores/workspace-store";
import { useConversationStore } from "../../stores/conversation-store";
import { useWorktreeScriptStore } from "../../stores/worktree-script-store";
import * as bridge from "../../lib/bridge";
import { ProjectIcon } from "../../shared/ProjectIcon";
import { RuntimeIndicator } from "../../shared/RuntimeIndicator";
import {
  ChevronRightIcon,
  DotsHorizontalIcon,
  GitBranchIcon,
  PencilIcon,
  PlusIcon,
} from "../../shared/Icons";
import { Tooltip } from "../../shared/Tooltip";
import type {
  EnvironmentRecord,
  ProjectRecord,
  ThreadConversationSnapshot,
  ThreadRecord,
} from "../../lib/types";
import { SidebarThreadRow } from "./SidebarThreadRow";
import { SidebarUsagePanel } from "./SidebarUsagePanel";
import { SidebarUtilityActions } from "./SidebarUtilityActions";
import type { Theme } from "./StudioShell";
import {
  archiveThreadWithConfirmation,
  createThreadForEnvironment,
  openThreadDraftForProject,
} from "./studioActions";
import {
  projectGroupClassName,
  useTreeSidebarReorder,
} from "./useTreeSidebarReorder";
import { useProjectImport } from "./useProjectImport";
import "./TreeSidebar.css";

type Props = {
  theme: Theme;
  collapsed?: boolean;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
};

type ContextMenuState = {
  kind: "project" | "thread" | "branch";
  projectId?: string;
  projectName?: string;
  environmentId?: string;
  environmentName?: string;
  branchName?: string;
  path?: string;
  pullRequestUrl?: string;
  activeThreadCount?: number;
  archivedThreadCount?: number;
  threadId?: string;
  threadTitle?: string;
  threadWorktreeEnvId?: string | null;
  threadWorktreeBranch?: string | null;
  x: number;
  y: number;
};

const PROJECT_REMOVAL_BLOCKED_MESSAGE =
  `Delete this project's worktrees before removing it from ${APP_NAME}.`;
const PROJECT_REMOVAL_DIALOG_TITLE = "Remove project";

export function TreeSidebar({ theme, collapsed = false, onOpenSettings, onToggleTheme }: Props) {
  const projects = useWorkspaceStore(selectProjects);
  const selectedProjectId = useWorkspaceStore((s) => s.selectedProjectId);
  const refreshSnapshot = useWorkspaceStore((s) => s.refreshSnapshot);
  const reorderProjects = useWorkspaceStore((s) => s.reorderProjects);
  const setProjectSidebarCollapsed = useWorkspaceStore(
    (s) => s.setProjectSidebarCollapsed,
  );
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
  const notice = actionError ?? error;
  const {
    dragState,
    orderedProjects,
    registerProjectItem,
    handleProjectPointerDown,
    handleProjectKeyboardReorder,
    projectDragStyle,
    shouldSuppressClick,
  } = useTreeSidebarReorder({
    projects,
    reorderProjects,
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

  function handleThreadSelect(threadId: string) {
    resetMessages();
    selectThread(threadId);
  }

  function handleOpenThreadInOtherPane(threadId: string) {
    resetMessages();
    useWorkspaceStore.getState().openThreadInOtherPane(threadId);
  }

  async function handleCreateThreadInEnvironment(environmentId: string) {
    resetMessages();
    try {
      const created = await createThreadForEnvironment(environmentId);
      if (!created) {
        setActionError(
          "Thread created, but the workspace failed to refresh. Reload to see it.",
        );
      }
    } catch (cause: unknown) {
      setActionError(actionErrorMessage(cause, "Failed to create thread"));
    }
  }

  function handleOpenThreadDraft(projectId: string) {
    resetMessages();
    openThreadDraftForProject(projectId);
  }

  function renderProjectThreads(project: ProjectRecord) {
    const localEnvironment = project.environments.find(
      (candidate) => candidate.kind === "local",
    );
    const worktreeEnvironments = project.environments.filter(
      (environment) => environment.kind !== "local",
    );
    const localThreads = localEnvironment
      ? localEnvironment.threads
          .filter((thread) => thread.status === "active")
          .sort(sortThreadsByUpdatedAtDesc)
      : [];
    const worktreeRows = buildFlattenedWorktreeRows(worktreeEnvironments);

    if (localThreads.length === 0 && worktreeRows.length === 0) {
      return (
        <div className="project-group__threads project-group__threads--empty">
          <p className="project-group__empty-hint">
            No threads yet — click{" "}
            <span aria-hidden>
              <PencilIcon size={10} />
            </span>{" "}
            to start one.
          </p>
        </div>
      );
    }

    return (
      <ul className="project-group__threads">
        {localThreads.map((thread) => (
          <li key={thread.id} className="project-group__thread-item">
            <SidebarThreadRow
              thread={thread}
              onSelect={() => handleThreadSelect(thread.id)}
              onOpenInOtherPane={() => handleOpenThreadInOtherPane(thread.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({
                  kind: "thread",
                  threadId: thread.id,
                  threadTitle: thread.title,
                  threadWorktreeEnvId: null,
                  threadWorktreeBranch: null,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            />
          </li>
        ))}
        {worktreeRows.map((row) => {
          const env = row.environment;
          const branchLabel = resolveWorktreeBranchLabel(env);
          const openBranchMenu = (event: React.MouseEvent<HTMLElement>) => {
            event.preventDefault();
            event.stopPropagation();
            const anchor = resolveContextMenuAnchor(event);
            setContextMenu(buildBranchContextMenuState(env, anchor.x, anchor.y));
          };

          if (row.kind === "empty") {
            return (
              <li key={env.id} className="project-group__thread-item">
                <div className="tree-sidebar__thread-row">
                  <button
                    type="button"
                    className="tree-sidebar__thread tree-sidebar__thread--placeholder tree-sidebar__thread--with-worktree"
                    aria-label={`Start thread in ${branchLabel}`}
                    title={`Start thread in ${branchLabel}`}
                    onClick={() => void handleCreateThreadInEnvironment(env.id)}
                    onContextMenu={openBranchMenu}
                  >
                    <span className="tree-sidebar__thread-indicator">
                      <EnvironmentConversationIndicator environment={env} />
                    </span>
                    <span className="tree-sidebar__thread-title">
                      Start thread
                    </span>
                  </button>
                  <button
                    type="button"
                    className="tree-sidebar__thread-branch"
                    title={`Worktree: ${branchLabel}`}
                    data-no-reorder-drag="true"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={openBranchMenu}
                  >
                    <GitBranchIcon
                      size={10}
                      className="tree-sidebar__thread-branch-icon"
                    />
                    <span className="tree-sidebar__thread-branch-label">
                      {branchLabel}
                    </span>
                  </button>
                </div>
              </li>
            );
          }

          const thread = row.thread;
          return (
            <li key={thread.id} className="project-group__thread-item">
              <SidebarThreadRow
                thread={thread}
                worktree={{
                  environmentId: env.id,
                  branch: branchLabel,
                }}
                onSelect={() => handleThreadSelect(thread.id)}
                onOpenInOtherPane={() =>
                  handleOpenThreadInOtherPane(thread.id)
                }
                onBranchChipClick={(event) => {
                  const anchor = resolveContextMenuAnchor(event);
                  setContextMenu(
                    buildBranchContextMenuState(env, anchor.x, anchor.y),
                  );
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({
                    kind: "thread",
                    threadId: thread.id,
                    threadTitle: thread.title,
                    threadWorktreeEnvId: env.id,
                    threadWorktreeBranch: branchLabel,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              />
            </li>
          );
        })}
      </ul>
    );
  }

  async function handleArchiveThreadFromMenu(threadId: string) {
    setContextMenu(null);
    resetMessages();
    try {
      await archiveThreadWithConfirmation(threadId);
    } catch (cause: unknown) {
      setActionError(actionErrorMessage(cause, "Failed to archive thread"));
    }
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
      `Remove "${projectName}" from ${APP_NAME}? The repository stays on disk. ${APP_NAME} may also remove its empty managed worktree folder.`,
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

  function handleProjectHeaderClick(
    event: ReactMouseEvent<HTMLElement>,
    project: ProjectRecord,
  ) {
    if (shouldSuppressClick()) {
      event.preventDefault();
      return;
    }

    void handleProjectCollapseToggle(project);
  }

  function handleProjectHeaderKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    project: ProjectRecord,
  ) {
    if (
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      void handleProjectKeyboardReorder(event, project.id);
      return;
    }

    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void handleProjectCollapseToggle(project);
  }

  async function handleDeleteWorktree(menu: ContextMenuState) {
    if (menu.kind !== "branch" || !menu.environmentId || !menu.environmentName) {
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
    <aside className={`tree-sidebar ${collapsed ? "tree-sidebar--collapsed" : ""}`} inert={collapsed || undefined}>
      <div className="tree-sidebar__header">
        <span className="tree-sidebar__title tx-section-label">Projects</span>
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
                  onClick={(event) => handleProjectHeaderClick(event, project)}
                  onContextMenu={(event) => {
                    event.preventDefault();
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
                    aria-expanded={!project.sidebarCollapsed}
                    onKeyDown={(event) =>
                      handleProjectHeaderKeyDown(event, project)
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
                  <Tooltip content="Project menu" side="bottom">
                    <button
                      type="button"
                      className="project-group__menu"
                      data-no-reorder-drag="true"
                      aria-label={`Actions for ${project.name}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        setContextMenu(
                          buildProjectContextMenuState(
                            project.id,
                            project.name,
                            rect.left,
                            rect.bottom + 4,
                          ),
                        );
                      }}
                    >
                      <DotsHorizontalIcon size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip content="New thread" side="bottom">
                    <button
                      type="button"
                      className="project-group__new-thread"
                      data-no-reorder-drag="true"
                      aria-label={`New thread in ${project.name}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        handleOpenThreadDraft(project.id);
                      }}
                    >
                      <PencilIcon size={13} />
                    </button>
                  </Tooltip>
                </div>
                {!project.sidebarCollapsed &&
                  renderProjectThreads(project)}
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
            className="tree-sidebar__context-menu tx-dropdown-menu"
            style={resolveContextMenuPosition(contextMenu)}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {contextMenu.kind === "project" ? (
              <>
                <button
                  type="button"
                  className="tree-sidebar__context-item tx-dropdown-option"
                  onClick={() => {
                    setContextMenu(null);
                    if (contextMenu.projectId) {
                      handleOpenThreadDraft(contextMenu.projectId);
                    }
                  }}
                >
                  New thread
                </button>
                <div className="tree-sidebar__context-separator" />
                <button
                  type="button"
                  className="tree-sidebar__context-item tx-dropdown-option tree-sidebar__context-item--danger"
                  onClick={() =>
                    void handleRemoveProject(
                      contextMenu.projectId ?? "",
                      contextMenu.projectName ?? "Project",
                    )
                  }
                >
                  {`Remove from ${APP_NAME}`}
                </button>
              </>
            ) : contextMenu.kind === "branch" ? (
              <>
                <button
                  type="button"
                  className="tree-sidebar__context-item tx-dropdown-option"
                  onClick={() => {
                    const envId = contextMenu.environmentId;
                    setContextMenu(null);
                    if (envId) void handleCreateThreadInEnvironment(envId);
                  }}
                >
                  {contextMenu.branchName
                    ? `New thread in ${contextMenu.branchName}`
                    : "New thread here"}
                </button>
                {contextMenu.pullRequestUrl ? (
                  <button
                    type="button"
                    className="tree-sidebar__context-item tx-dropdown-option"
                    onClick={() => {
                      const url = contextMenu.pullRequestUrl;
                      setContextMenu(null);
                      if (url) {
                        void Promise.resolve(openUrl(url)).catch(
                          () => undefined,
                        );
                      }
                    }}
                  >
                    Open pull request
                  </button>
                ) : null}
                <div className="tree-sidebar__context-separator" />
                <button
                  type="button"
                  className="tree-sidebar__context-item tx-dropdown-option tree-sidebar__context-item--danger"
                  onClick={() => void handleDeleteWorktree(contextMenu)}
                >
                  Delete worktree
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="tree-sidebar__context-item tx-dropdown-option"
                  onClick={() => {
                    setContextMenu(null);
                    if (contextMenu.threadId) {
                      handleOpenThreadInOtherPane(contextMenu.threadId);
                    }
                  }}
                >
                  Open in other pane
                </button>
                {contextMenu.threadWorktreeEnvId ? (
                  <button
                    type="button"
                    className="tree-sidebar__context-item tx-dropdown-option"
                    onClick={() => {
                      const envId = contextMenu.threadWorktreeEnvId;
                      setContextMenu(null);
                      if (envId) void handleCreateThreadInEnvironment(envId);
                    }}
                  >
                    {contextMenu.threadWorktreeBranch
                      ? `New thread in ${contextMenu.threadWorktreeBranch}`
                      : "New thread in same worktree"}
                  </button>
                ) : null}
                <div className="tree-sidebar__context-separator" />
                <button
                  type="button"
                  className="tree-sidebar__context-item tx-dropdown-option tree-sidebar__context-item--danger"
                  onClick={() => {
                    if (contextMenu.threadId) {
                      void handleArchiveThreadFromMenu(contextMenu.threadId);
                    }
                  }}
                >
                  Archive thread
                </button>
              </>
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

function resolveContextMenuAnchor(event: React.MouseEvent<HTMLElement>) {
  if (event.clientX !== 0 || event.clientY !== 0) {
    return { x: event.clientX, y: event.clientY };
  }
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.bottom + 4,
  };
}

function buildBranchContextMenuState(
  environment: EnvironmentRecord,
  x: number,
  y: number,
): ContextMenuState {
  return {
    kind: "branch",
    environmentId: environment.id,
    environmentName: environment.name,
    branchName: resolveWorktreeBranchLabel(environment),
    pullRequestUrl: environment.pullRequest?.url,
    path: environment.path,
    activeThreadCount: environment.threads.filter(
      (candidate) => candidate.status === "active",
    ).length,
    archivedThreadCount: environment.threads.filter(
      (candidate) => candidate.status === "archived",
    ).length,
    x,
    y,
  };
}

type FlattenedWorktreeRow =
  | {
      kind: "thread";
      environment: EnvironmentRecord;
      thread: ThreadRecord;
    }
  | {
      kind: "empty";
      environment: EnvironmentRecord;
    };

function buildFlattenedWorktreeRows(
  environments: EnvironmentRecord[],
): FlattenedWorktreeRow[] {
  const rows: FlattenedWorktreeRow[] = [];
  for (const environment of environments) {
    const activeThreads = environment.threads
      .filter((thread) => thread.status === "active")
      .sort(sortThreadsByUpdatedAtDesc);
    if (activeThreads.length === 0) {
      rows.push({ kind: "empty", environment });
      continue;
    }
    for (const thread of activeThreads) {
      rows.push({ kind: "thread", environment, thread });
    }
  }

  return rows
    .sort((left, right) => {
      const activityOrder =
        flattenedWorktreeRowTimestamp(right) - flattenedWorktreeRowTimestamp(left);
      if (activityOrder !== 0) {
        return activityOrder;
      }
      const branchOrder = resolveWorktreeBranchLabel(
        left.environment,
      ).localeCompare(resolveWorktreeBranchLabel(right.environment));
      if (branchOrder !== 0) {
        return branchOrder;
      }
      if (left.kind === "empty" || right.kind === "empty") {
        return left.kind === "empty" ? 1 : -1;
      }
      return left.thread.title.localeCompare(right.thread.title);
    });
}

function sortThreadsByUpdatedAtDesc(left: ThreadRecord, right: ThreadRecord) {
  return timestampOf(right.updatedAt) - timestampOf(left.updatedAt);
}

function flattenedWorktreeRowTimestamp(row: FlattenedWorktreeRow) {
  if (row.kind === "thread") {
    return timestampOf(row.thread.updatedAt);
  }
  return latestEnvironmentActivityTimestamp(row.environment);
}

function latestEnvironmentActivityTimestamp(environment: EnvironmentRecord) {
  return environment.threads.reduce(
    (latest, thread) => Math.max(latest, timestampOf(thread.updatedAt)),
    timestampOf(environment.updatedAt),
  );
}

function resolveWorktreeBranchLabel(environment: EnvironmentRecord) {
  return environment.gitBranch ?? environment.name;
}

function timestampOf(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function resolveContextMenuPosition(
  contextMenu: Pick<ContextMenuState, "x" | "y">,
) {
  const menuWidth = 220;
  // Each .tx-dropdown-option is ~40px tall (incl. padding). Project, branch,
  // and thread menus all fit within the same conservative height budget.
  const menuHeight = 160;
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
