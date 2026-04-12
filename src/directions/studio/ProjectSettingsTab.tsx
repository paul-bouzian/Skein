import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import type { ProjectRecord, ProjectSettingsPatch } from "../../lib/types";
import { ChevronRightIcon } from "../../shared/Icons";

type Props = {
  projects: ProjectRecord[];
  selectedProjectId: string | null;
  onSave: (projectId: string, patch: ProjectSettingsPatch) => Promise<void>;
};

type ProjectDraft = {
  setup: string;
  teardown: string;
  savedSetup: string;
  savedTeardown: string;
};

export function ProjectSettingsTab({
  projects,
  selectedProjectId,
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

  if (projects.length === 0) {
    return <p className="settings-dialog__empty">No projects yet.</p>;
  }

  return (
    <div className="settings-project-list">
      {projects.map((project) => {
        const draft =
          draftsByProjectId[project.id] ??
          buildProjectDraft(project.settings.worktreeSetupScript, project.settings.worktreeTeardownScript);
        const isExpanded = expandedProjectId === project.id;
        const isSaving = savingByProjectId[project.id] ?? false;
        const isDirty =
          draft.setup !== draft.savedSetup || draft.teardown !== draft.savedTeardown;

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
                    Runs once after Loom creates the worktree, with the new
                    worktree as the current directory. It runs in the
                    background and does not block opening the thread.
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
                    Runs after Loom deletes the worktree, from the project
                    root. Context is exposed through `LOOM_*` environment
                    variables.
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
                        }),
                      )
                    }
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    className="tx-action-btn tx-action-btn--primary"
                    disabled={isSaving || !isDirty}
                    onClick={() => {
                      void saveProjectDraft(
                        project.id,
                        draft,
                        onSave,
                        setSavingByProjectId,
                        setDraftsByProjectId,
                      ).catch(() => {
                        // The parent settings dialog already surfaces save failures.
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
  setSavingByProjectId((current) => ({ ...current, [projectId]: true }));

  try {
    await onSave(projectId, {
      worktreeSetupScript: setup,
      worktreeTeardownScript: teardown,
    });
    updateProjectDraft(
      setDraftsByProjectId,
      projectId,
      buildProjectDraft(setup, teardown),
      () => buildProjectDraft(setup, teardown),
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

function syncProjectDrafts(
  projects: ProjectRecord[],
  current: Record<string, ProjectDraft>,
) {
  const next: Record<string, ProjectDraft> = {};

  for (const project of projects) {
    const savedSetup = project.settings.worktreeSetupScript ?? "";
    const savedTeardown = project.settings.worktreeTeardownScript ?? "";
    const existing = current[project.id];
    if (!existing) {
      next[project.id] = buildProjectDraft(savedSetup, savedTeardown);
      continue;
    }

    const isDirty =
      existing.setup !== existing.savedSetup ||
      existing.teardown !== existing.savedTeardown;
    next[project.id] = isDirty
      ? existing
      : buildProjectDraft(savedSetup, savedTeardown);
  }

  return next;
}

function buildProjectDraft(
  setup: string | null | undefined,
  teardown: string | null | undefined,
): ProjectDraft {
  return {
    setup: setup ?? "",
    teardown: teardown ?? "",
    savedSetup: setup ?? "",
    savedTeardown: teardown ?? "",
  };
}

function normalizeScriptDraft(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
