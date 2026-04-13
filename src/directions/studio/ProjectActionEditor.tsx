import { buildShortcutValue, formatShortcut } from "../../lib/shortcuts";
import { ChevronRightIcon } from "../../shared/Icons";
import { ProjectActionIcon } from "./ProjectActionIcon";
import {
  PROJECT_ACTION_ICON_OPTIONS,
  PROJECT_ACTION_LABEL_SUGGESTIONS,
  type ProjectActionDraft,
} from "./projectActions";
import type { ProjectActionDraftIssues } from "./projectSettingsDraft";

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
  const suggestionListId = `${projectId}-${action.id}-label-suggestions`;

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
        <>
          <div className="settings-field">
            <span className="settings-field__label">Icon</span>
            <div className="settings-project-action__icons" role="list">
              {PROJECT_ACTION_ICON_OPTIONS.map((option) => {
                const selected = action.icon === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`settings-project-action__icon-btn ${
                      selected ? "settings-project-action__icon-btn--selected" : ""
                    }`}
                    disabled={disabled}
                    onClick={() => onUpdate({ ...action, icon: option.id })}
                  >
                    <ProjectActionIcon icon={option.id} size={16} />
                    <span>{option.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="settings-field">
            <label className="settings-field__label" htmlFor={`${action.id}-label`}>
              Label
            </label>
            <input
              id={`${action.id}-label`}
              className="settings-field__input"
              list={suggestionListId}
              value={action.label}
              placeholder="Dev"
              disabled={disabled}
              onChange={(event) => onUpdate({ ...action, label: event.target.value })}
            />
            <datalist id={suggestionListId}>
              {PROJECT_ACTION_LABEL_SUGGESTIONS.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
            <div className="settings-project-action__chips">
              {PROJECT_ACTION_LABEL_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="settings-project-action__chip"
                  disabled={disabled}
                  onClick={() => onUpdate({ ...action, label: suggestion })}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            {issue?.label ? (
              <p className="settings-field__help settings-field__help--error">{issue.label}</p>
            ) : null}
          </div>

          <div className="settings-field">
            <label className="settings-field__label" htmlFor={`${action.id}-shortcut`}>
              Shortcut <span className="settings-project-action__optional">(Optional)</span>
            </label>
            <div className="settings-project-action__shortcut-row">
              <input
                id={`${action.id}-shortcut`}
                className="settings-field__input settings-project-action__shortcut"
                aria-label={`${action.label || "Project action"} shortcut`}
                readOnly
                disabled={disabled}
                placeholder="Type shortcut"
                value={capturingShortcut ? "" : formatShortcut(action.shortcut || null)}
                onFocus={onCaptureStart}
                onBlur={onCaptureEnd}
                onKeyDown={(event) => {
                  if (event.key === "Tab" && !event.shiftKey) {
                    onCaptureEnd();
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    onCaptureEnd();
                    return;
                  }
                  if (event.key === "Backspace" || event.key === "Delete") {
                    event.preventDefault();
                    onUpdate({ ...action, shortcut: "" });
                    onCaptureEnd();
                    return;
                  }
                  const nextValue = buildShortcutValue(event.nativeEvent);
                  if (!nextValue) {
                    return;
                  }
                  event.preventDefault();
                  onUpdate({ ...action, shortcut: nextValue });
                  onCaptureEnd();
                }}
              />
              <button
                type="button"
                className="tx-action-btn tx-action-btn--secondary settings-project-action__shortcut-clear"
                disabled={disabled || action.shortcut.trim().length === 0}
                onClick={() => onUpdate({ ...action, shortcut: "" })}
              >
                Clear
              </button>
            </div>
            {capturingShortcut ? (
              <p className="settings-field__help">
                Press a shortcut. Backspace clears. Escape cancels.
              </p>
            ) : null}
            {issue?.shortcut ? (
              <p className="settings-field__help settings-field__help--error">{issue.shortcut}</p>
            ) : null}
          </div>

          <div className="settings-field">
            <label className="settings-field__label" htmlFor={`${action.id}-script`}>
              Script
            </label>
            <textarea
              id={`${action.id}-script`}
              className="settings-field__textarea"
              rows={4}
              value={action.script}
              placeholder="bun run dev"
              spellCheck={false}
              disabled={disabled}
              onChange={(event) => onUpdate({ ...action, script: event.target.value })}
            />
            {issue?.script ? (
              <p className="settings-field__help settings-field__help--error">{issue.script}</p>
            ) : null}
          </div>
        </>
      ) : null}
    </article>
  );
}
