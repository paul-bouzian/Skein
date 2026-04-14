import { ChevronRightIcon } from "../../shared/Icons";
import { ProjectActionIcon } from "./ProjectActionIcon";
import type { ProjectActionDraft } from "./projectActions";
import type { ProjectActionDraftIssues } from "./projectSettingsDraft";
import { ProjectActionFields } from "./ProjectActionFields";

type Props = {
  projectId: string;
  action: ProjectActionDraft;
  issue: ProjectActionDraftIssues | undefined;
  disabled: boolean;
  expanded: boolean;
  capturingShortcut: boolean;
  onCaptureStart: () => void;
  onCaptureEnd: () => void;
  onToggleExpanded: () => void;
  onRemove: () => void;
  onUpdate: (action: ProjectActionDraft) => void;
};

export function ProjectActionEditor({
  projectId,
  action,
  issue,
  disabled,
  expanded,
  capturingShortcut,
  onCaptureStart,
  onCaptureEnd,
  onToggleExpanded,
  onRemove,
  onUpdate,
}: Props) {
  return (
    <article className="settings-project-action">
      <div className="settings-project-action__header">
        <button
          type="button"
          className="settings-project-action__summary"
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          <ChevronRightIcon
            size={12}
            className={`settings-project-action__summary-chevron ${
              expanded ? "settings-project-action__summary-chevron--expanded" : ""
            }`}
          />
          <div className="settings-project-action__preview">
            <ProjectActionIcon icon={action.icon} size={18} />
            <span className="settings-project-action__preview-label">
              {action.label.trim() || "New action"}
            </span>
          </div>
        </button>
        <button
          type="button"
          className="tx-action-btn tx-action-btn--secondary"
          disabled={disabled}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>

      {expanded ? (
        <ProjectActionFields
          projectId={projectId}
          action={action}
          issue={issue}
          disabled={disabled}
          capturingShortcut={capturingShortcut}
          onCaptureStart={onCaptureStart}
          onCaptureEnd={onCaptureEnd}
          onUpdate={onUpdate}
        />
      ) : null}
    </article>
  );
}
