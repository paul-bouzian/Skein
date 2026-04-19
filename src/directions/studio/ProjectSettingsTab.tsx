import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import type { ProjectRecord, ProjectSettingsPatch, ShortcutSettings } from "../../lib/types";
import { ChevronRightIcon, PlusIcon } from "../../shared/Icons";
import { APP_NAME } from "../../lib/app-identity";
import { ProjectActionEditor } from "./ProjectActionEditor";
import {
  createEmptyProjectActionDraft,
  normalizeProjectActionDrafts,
} from "./projectActions";
import {
  buildProjectDraft,
  cloneActionDraft,
  normalizeScriptDraft,
  projectDraftDirty,
  syncProjectDrafts,
  validateProjectDraft,
  type ProjectDraft,
} from "./projectSettingsDraft";

type Props = {
  projects: ProjectRecord[];
  selectedProjectId: string | null;
  shortcutSettings: ShortcutSettings;
  onSave: (projectId: string, patch: ProjectSettingsPatch) => Promise<void>;
};

export function ProjectSettingsTab({
  projects,
  selectedProjectId,
  shortcutSettings,
  onSave,
}: Props) {
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(
    selectedProjectId ?? projects[0]?.id ?? null,
  );
  const [draftsByProjectId, setDraftsByProjectId] = useState<
    Record<string, ProjectDraft>
  >({});
  const [savingByProjectId, setSavingByProjectId] = useState<
    Record<string, boolean>
  >({});
  const [expandedActionIdsByProjectId, setExpandedActionIdsByProjectId] = useState<
    Record<string, string[]>
  >({});
  const [capturingShortcutActionId, setCapturingShortcutActionId] = useState<string | null>(
    null,
  );
  const projectIds = useMemo(() => new Set(projects.map((project) => project.id)), [projects]);

  useEffect(() => {
    if (projects.length === 0) {
      setExpandedProjectId(null);
      return;
    }

    setExpandedProjectId((current) => {
      if (current && projectIds.has(current)) {
        return current;
      }
      if (selectedProjectId && projectIds.has(selectedProjectId)) {
        return selectedProjectId;
      }
      return projects[0].id;
    });
  }, [projectIds, projects, selectedProjectId]);

  useEffect(() => {
    setDraftsByProjectId((current) => syncProjectDrafts(projects, current));
  }, [projects]);

  useEffect(() => {
    setExpandedActionIdsByProjectId((current) => {
      const next: Record<string, string[]> = {};

      for (const project of projects) {
        const actionIds = (project.settings.manualActions ?? []).map((action) => action.id);
        const existing = current[project.id];
        if (existing) {
          next[project.id] = existing.filter((actionId) => actionIds.includes(actionId));
          continue;
        }
        next[project.id] = [];
      }

      return next;
    });
  }, [projects]);

  if (projects.length === 0) {
    return <p className="settings-empty">No projects yet.</p>;
  }

  return (
    <div className="settings-project-list">
      {projects.map((project) => {
        const draft =
          draftsByProjectId[project.id] ??
          buildProjectDraft(
            project.settings.worktreeSetupScript,
            project.settings.worktreeTeardownScript,
            project.settings.manualActions ?? [],
          );
        const isExpanded = expandedProjectId === project.id;
        const isSaving = savingByProjectId[project.id] ?? false;
        const issues = validateProjectDraft(draft, shortcutSettings);
        const isDirty = projectDraftDirty(draft);
        const expandedActionIds = expandedActionIdsByProjectId[project.id] ?? [];

        return (
          <section key={project.id} className="settings-project-card">
            <button
              type="button"
              className="settings-project-card__header"
              onClick={() =>
                setExpandedProjectId((current) =>
                  current === project.id ? null : project.id,
                )
              }
              aria-expanded={isExpanded}
            >
              <span className="settings-project-card__header-main">
                <ChevronRightIcon
                  size={12}
                  className={`settings-project-card__chevron ${
                    isExpanded ? "settings-project-card__chevron--expanded" : ""
                  }`}
                />
                <span className="settings-project-card__title">{project.name}</span>
              </span>
              <span className="settings-project-card__path">{project.rootPath}</span>
            </button>

            {isExpanded ? (
              <div className="settings-project-card__body">
                <div className="settings-field">
                  <label className="settings-field__label" htmlFor={`${project.id}-setup-script`}>
                    Setup Script
                  </label>
                  <p className="settings-field__help">
                    Runs once after {APP_NAME} creates the worktree, from the worktree dir.
                    Non-blocking.
                  </p>
                  <textarea
                    id={`${project.id}-setup-script`}
                    className="settings-field__textarea"
                    rows={5}
                    value={draft.setup}
                    placeholder="./scripts/worktree-setup.sh"
                    spellCheck={false}
                    disabled={isSaving}
                    onChange={(event) =>
                      updateProjectDraft(
                        setDraftsByProjectId,
                        project.id,
                        draft,
                        (currentDraft) => ({
                          ...currentDraft,
                          setup: event.target.value,
                        }),
                      )
                    }
                  />
                </div>

                <div className="settings-field">
                  <label
                    className="settings-field__label"
                    htmlFor={`${project.id}-teardown-script`}
                  >
                    Teardown Script
                  </label>
                  <p className="settings-field__help">
                    Runs after {APP_NAME} deletes the worktree, from the project root. `SKEIN_*`
                    env vars expose context.
                  </p>
                  <textarea
                    id={`${project.id}-teardown-script`}
                    className="settings-field__textarea"
                    rows={5}
                    value={draft.teardown}
                    placeholder="./scripts/worktree-cleanup.sh"
                    spellCheck={false}
                    disabled={isSaving}
                    onChange={(event) =>
                      updateProjectDraft(
                        setDraftsByProjectId,
                        project.id,
                        draft,
                        (currentDraft) => ({
                          ...currentDraft,
                          teardown: event.target.value,
                        }),
                      )
                    }
                  />
                </div>

                <div className="settings-project-actions">
                  <div className="settings-project-actions__header">
                    <div className="settings-project-actions__copy">
                      <h3 className="settings-project-actions__title">Actions</h3>
                      <p className="settings-field__help">
                        Reusable actions for every environment in this project, shown beside the
                        terminal and Open In controls.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="settings-project-actions__add"
                      aria-label="Add action"
                      title="Add action"
                      disabled={isSaving}
                      onClick={() => {
                        const nextAction = createEmptyProjectActionDraft();
                        updateProjectDraft(
                          setDraftsByProjectId,
                          project.id,
                          draft,
                          (currentDraft) => ({
                            ...currentDraft,
                            actions: [...currentDraft.actions, nextAction],
                          }),
                        );
                        setExpandedActionIdsByProjectId((current) => ({
                          ...current,
                          [project.id]: [...(current[project.id] ?? []), nextAction.id],
                        }));
                      }}
                    >
                      <PlusIcon size={12} />
                    </button>
                  </div>
                  {issues.global ? (
                    <p className="settings-notice">{issues.global}</p>
                  ) : null}
                  {draft.actions.length === 0 ? (
                    <p className="settings-field__help">
                      No manual actions yet. Add one to make it available in every
                      environment.
                    </p>
                  ) : (
                    <div className="settings-project-actions__list">
                      {draft.actions.map((action) => (
                        <ProjectActionEditor
                          key={action.id}
                          projectId={project.id}
                          action={action}
                          issue={issues.actionsById[action.id]}
                          disabled={isSaving}
                          expanded={expandedActionIds.includes(action.id)}
                          capturingShortcut={capturingShortcutActionId === action.id}
                          onCaptureStart={() => setCapturingShortcutActionId(action.id)}
                          onCaptureEnd={() =>
                            setCapturingShortcutActionId((current) =>
                              current === action.id ? null : current,
                            )
                          }
                          onToggleExpanded={() => {
                            setCapturingShortcutActionId((current) =>
                              current === action.id ? null : current,
                            );
                            setExpandedActionIdsByProjectId((current) => {
                              const existing = current[project.id] ?? [];
                              const next = existing.includes(action.id)
                                ? existing.filter((actionId) => actionId !== action.id)
                                : [...existing, action.id];
                              return {
                                ...current,
                                [project.id]: next,
                              };
                            });
                          }}
                          onRemove={() => {
                            setCapturingShortcutActionId((current) =>
                              current === action.id ? null : current,
                            );
                            setExpandedActionIdsByProjectId((current) => ({
                              ...current,
                              [project.id]: (current[project.id] ?? []).filter(
                                (actionId) => actionId !== action.id,
                              ),
                            }));
                            updateProjectDraft(
                              setDraftsByProjectId,
                              project.id,
                              draft,
                              (currentDraft) => ({
                                ...currentDraft,
                                actions: currentDraft.actions.filter(
                                  (candidate) => candidate.id !== action.id,
                                ),
                              }),
                            );
                          }}
                          onUpdate={(nextAction) =>
                            updateProjectDraft(
                              setDraftsByProjectId,
                              project.id,
                              draft,
                              (currentDraft) => ({
                                ...currentDraft,
                                actions: currentDraft.actions.map((candidate) =>
                                  candidate.id === action.id ? nextAction : candidate,
                                ),
                              }),
                            )
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>

                <div className="settings-project-card__actions">
                  <button
                    type="button"
                    className="tx-action-btn tx-action-btn--secondary"
                    disabled={isSaving || !isDirty}
                    onClick={() =>
                      updateProjectDraft(
                        setDraftsByProjectId,
                        project.id,
                        draft,
                        (currentDraft) => ({
                          ...currentDraft,
                          setup: currentDraft.savedSetup,
                          teardown: currentDraft.savedTeardown,
                          actions: currentDraft.savedActions.map(cloneActionDraft),
                        }),
                      )
                    }
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    className="tx-action-btn tx-action-btn--primary"
                    disabled={isSaving || !isDirty || issues.global != null}
                    onClick={() => {
                      void saveProjectDraft(
                        project.id,
                        draft,
                        onSave,
                        setSavingByProjectId,
                        setDraftsByProjectId,
                      ).catch(() => {
                        /* parent surfaces save errors */
                      });
                    }}
                  >
                    {isSaving ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

async function saveProjectDraft(
  projectId: string,
  draft: ProjectDraft,
  onSave: Props["onSave"],
  setSavingByProjectId: Dispatch<SetStateAction<Record<string, boolean>>>,
  setDraftsByProjectId: Dispatch<SetStateAction<Record<string, ProjectDraft>>>,
) {
  const setup = normalizeScriptDraft(draft.setup);
  const teardown = normalizeScriptDraft(draft.teardown);
  const actions = normalizeProjectActionDrafts(draft.actions);
  setSavingByProjectId((current) => ({ ...current, [projectId]: true }));

  try {
    await onSave(projectId, {
      worktreeSetupScript: setup,
      worktreeTeardownScript: teardown,
      manualActions: actions,
    });
    updateProjectDraft(
      setDraftsByProjectId,
      projectId,
      buildProjectDraft(setup, teardown, actions),
      () => buildProjectDraft(setup, teardown, actions),
    );
  } finally {
    setSavingByProjectId((current) => ({ ...current, [projectId]: false }));
  }
}

function updateProjectDraft(
  setDraftsByProjectId: Dispatch<SetStateAction<Record<string, ProjectDraft>>>,
  projectId: string,
  fallbackDraft: ProjectDraft,
  update: (draft: ProjectDraft) => ProjectDraft,
) {
  setDraftsByProjectId((current) => {
    const existing = current[projectId] ?? fallbackDraft;
    return {
      ...current,
      [projectId]: update(existing),
    };
  });
}
