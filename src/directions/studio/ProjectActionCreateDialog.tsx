import { message } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { ProjectRecord, ShortcutSettings } from "../../lib/types";
import { CloseIcon } from "../../shared/Icons";
import { useWorkspaceStore } from "../../stores/workspace-store";
import {
  buildProjectActionDraft,
  createEmptyProjectActionDraft,
  normalizeProjectActionDraft,
  type ProjectActionDraft,
} from "./projectActions";
import { ProjectActionFields } from "./ProjectActionFields";
import { validateProjectActionDrafts } from "./projectSettingsDraft";
import "./ProjectActionCreateDialog.css";

type Props = {
  open: boolean;
  project: ProjectRecord | null;
  shortcutSettings: ShortcutSettings;
  onClose: () => void;
};

export function ProjectActionCreateDialog({
  open,
  project,
  shortcutSettings,
  onClose,
}: Props) {
  const updateProjectSettings = useWorkspaceStore((state) => state.updateProjectSettings);
  const [draft, setDraft] = useState<ProjectActionDraft>(createEmptyProjectActionDraft);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setDraft(createEmptyProjectActionDraft());
    setCapturingShortcut(false);
    setSaving(false);
    setSaveError(null);
  }, [open, project?.id]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || saving) {
        return;
      }

      queueMicrotask(() => {
        if (event.defaultPrevented) {
          return;
        }

        event.preventDefault();
        onClose();
      });
    }

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open, saving]);

  const issues = useMemo(() => {
    if (!project) {
      return { global: null, actionsById: {} };
    }

    return validateProjectActionDrafts(
      [
        ...(project.settings.manualActions ?? []).map(buildProjectActionDraft),
        draft,
      ],
      shortcutSettings,
    );
  }, [draft, project, shortcutSettings]);

  if (!open || !project) {
    return null;
  }

  const currentProject = project;
  const draftIssue = issues.actionsById[draft.id];

  async function handleCreate() {
    if (saving) {
      return;
    }
    if (issues.global) {
      setSaveError(issues.global);
      return;
    }

    setSaving(true);
    setSaveError(null);

    const result = await updateProjectSettings(currentProject.id, {
      manualActions: [
        ...(currentProject.settings.manualActions ?? []),
        normalizeProjectActionDraft(draft),
      ],
    });

    setSaving(false);
    if (!result.ok) {
      setSaveError(result.errorMessage ?? "Failed to save project settings");
      return;
    }
    if (result.warningMessage) {
      await message(result.warningMessage, {
        title: "Project action",
        kind: "warning",
      });
      onClose();
      return;
    }

    onClose();
  }

  return createPortal(
    <div className="project-action-create-dialog__backdrop" onClick={() => !saving && onClose()}>
      <section
        className="project-action-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-action-create-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-action-create-dialog__header">
          <div className="project-action-create-dialog__copy">
            <h2
              id="project-action-create-dialog-title"
              className="project-action-create-dialog__title"
            >
              Add Action
            </h2>
            <p className="settings-field__help">
              Create a reusable terminal action for {currentProject.name}.
            </p>
          </div>
          <button
            type="button"
            className="project-action-create-dialog__close"
            onClick={onClose}
            aria-label="Close add action dialog"
            title="Close add action dialog"
            disabled={saving}
          >
            <CloseIcon size={12} />
          </button>
        </div>

        <div className="project-action-create-dialog__body">
          {saveError ? <p className="settings-dialog__notice">{saveError}</p> : null}
          <ProjectActionFields
            projectId={currentProject.id}
            action={draft}
            issue={draftIssue}
            disabled={saving}
            capturingShortcut={capturingShortcut}
            onCaptureStart={() => setCapturingShortcut(true)}
            onCaptureEnd={() => setCapturingShortcut(false)}
            onUpdate={(nextDraft) => {
              setSaveError(null);
              setDraft(nextDraft);
            }}
          />
        </div>

        <div className="project-action-create-dialog__actions">
          <button
            type="button"
            className="tx-action-btn tx-action-btn--secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="tx-action-btn tx-action-btn--primary"
            onClick={() => void handleCreate()}
            disabled={saving}
          >
            {saving ? "Creating..." : "Create"}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
