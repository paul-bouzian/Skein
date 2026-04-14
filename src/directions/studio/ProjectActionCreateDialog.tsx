import { message } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
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

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

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
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const savingRef = useRef(saving);
  const onCloseRef = useRef(onClose);
  const projectId = project?.id ?? null;

  useEffect(() => {
    if (!open || !projectId) {
      return;
    }

    setDraft(createEmptyProjectActionDraft());
    setCapturingShortcut(false);
    setSaving(false);
    setSaveError(null);
  }, [open, projectId]);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || !projectId) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Tab") {
        trapDialogFocus(event, dialogRef.current);
        return;
      }
      if (event.key !== "Escape" || savingRef.current) {
        return;
      }

      queueMicrotask(() => {
        if (event.defaultPrevented) {
          return;
        }

        event.preventDefault();
        onCloseRef.current();
      });
    }

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    queueMicrotask(() => {
      dialogRef.current?.focus();
    });
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus();
      }
    };
  }, [open, projectId]);

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
    let shouldClose = false;

    try {
      const result = await updateProjectSettings(currentProject.id, {
        manualActions: [
          ...(currentProject.settings.manualActions ?? []),
          normalizeProjectActionDraft(draft),
        ],
      });

      if (!result.ok) {
        setSaveError(result.errorMessage ?? "Failed to save project settings");
        return;
      }
      if (result.warningMessage) {
        await message(result.warningMessage, {
          title: "Project action",
          kind: "warning",
        });
      }

      shouldClose = true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save project settings");
      return;
    } finally {
      setSaving(false);
    }

    if (shouldClose) {
      onClose();
    }
  }

  return createPortal(
    <div className="project-action-create-dialog__backdrop" onClick={() => !saving && onClose()}>
      <section
        ref={dialogRef}
        className="project-action-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-action-create-dialog-title"
        tabIndex={-1}
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

function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (!dialog || !(event.target instanceof Node) || !dialog.contains(event.target)) {
    return;
  }

  const focusable = getFocusableElements(dialog);
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const activeElement = document.activeElement;
  const firstElement = focusable[0];
  const lastElement = focusable[focusable.length - 1];

  if (event.shiftKey) {
    if (activeElement === firstElement || activeElement === dialog) {
      event.preventDefault();
      lastElement.focus();
    }
    return;
  }

  if (activeElement === lastElement) {
    event.preventDefault();
    firstElement.focus();
  }
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("disabled") && element.tabIndex >= 0,
  );
}
