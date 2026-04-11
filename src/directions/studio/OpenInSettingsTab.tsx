import { useEffect, useMemo, useState } from "react";

import type { OpenTarget, OpenTargetKind } from "../../lib/types";
import { useWorkspaceStore } from "../../stores/workspace-store";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CloseIcon,
  FolderIcon,
} from "../../shared/Icons";
import { OpenTargetIcon } from "./OpenTargetIcon";
import { useOpenAppIcons } from "./useOpenAppIcons";
import {
  buildDraftState,
  createDraftTarget,
  matchesPersistedTargets,
  moveDraftTarget,
  parseArgs,
  persistDraftTargets,
  validateDraftTargets,
  type OpenInDraftState,
  type DraftOpenTarget,
} from "./openInSettingsDraft";

type Props = {
  targets: OpenTarget[];
  defaultTargetId: string;
};

export function OpenInSettingsTab({ targets, defaultTargetId }: Props) {
  const updateGlobalSettings = useWorkspaceStore((state) => state.updateGlobalSettings);
  const [draftState, setDraftState] = useState<OpenInDraftState>(() =>
    buildDraftState(targets, defaultTargetId),
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const draftTargets = draftState.targets;
  const defaultDraftKey = draftState.defaultDraftKey;
  const appIcons = useOpenAppIcons(
    draftTargets.map((target) => ({
      id: target.id,
      label: target.label,
      kind: target.kind,
      appName: target.appName || null,
      command: target.command || null,
      args: parseArgs(target.argsText),
    })),
  );

  useEffect(() => {
    setDraftState(buildDraftState(targets, defaultTargetId));
    setSaveError(null);
    setSaving(false);
  }, [defaultTargetId, targets]);

  const issues = useMemo(
    () => validateDraftTargets(draftTargets, defaultDraftKey),
    [defaultDraftKey, draftTargets],
  );
  const dirty = useMemo(
    () => !matchesPersistedTargets(draftTargets, defaultDraftKey, targets, defaultTargetId),
    [defaultDraftKey, defaultTargetId, draftTargets, targets],
  );

  async function handleSave() {
    if (issues.global || Object.keys(issues.byKey).length > 0) {
      setSaveError(issues.global ?? "Complete the invalid targets before saving.");
      return;
    }

    const defaultTarget = draftTargets.find((target) => target.draftKey === defaultDraftKey);
    if (!defaultTarget) {
      setSaveError("Choose a default target before saving.");
      return;
    }

    const persistedDraftState = persistDraftTargets(draftState);
    if (!persistedDraftState) {
      setSaveError("Choose a default target before saving.");
      return;
    }

    setSaving(true);
    setSaveError(null);
    const result = await updateGlobalSettings(persistedDraftState);
    setSaving(false);

    if (!result.ok) {
      setSaveError(result.errorMessage ?? "Failed to save Open In settings.");
      return;
    }
    if (result.warningMessage) {
      setSaveError(result.warningMessage);
    }
  }

  function handleReset() {
    setDraftState(buildDraftState(targets, defaultTargetId));
    setSaveError(null);
  }

  function updateDraftState(
    updater: (current: OpenInDraftState) => OpenInDraftState,
  ) {
    setSaveError(null);
    setDraftState((current) => updater(current));
  }

  return (
    <div className="settings-open-targets">
      <div className="settings-open-targets__intro">
        <p className="settings-field__help">
          Pick the apps and commands shown in the toolbar. The main button opens
          the current environment with the saved default target.
        </p>
        <p className="settings-field__help">
          For command targets, provide one argument per line. Loom appends the
          environment path automatically.
        </p>
      </div>
      {saveError ? <p className="settings-dialog__notice">{saveError}</p> : null}
      <div className="settings-open-targets__list">
        {draftTargets.map((target, index) => (
          <OpenInTargetRow
            key={target.draftKey}
            target={target}
            iconUrl={target.appName ? appIcons[target.appName] : null}
            issue={issues.byKey[target.draftKey] ?? null}
            isDefault={target.draftKey === defaultDraftKey}
            canMoveUp={index > 0}
            canMoveDown={index < draftTargets.length - 1}
            disabled={saving}
            onChange={(patch) =>
              updateDraftState((current) => ({
                ...current,
                targets: current.targets.map((candidate) =>
                  candidate.draftKey === target.draftKey
                    ? { ...candidate, ...patch }
                    : candidate,
                ),
              }))
            }
            onSetDefault={() =>
              updateDraftState((current) => ({
                ...current,
                defaultDraftKey: target.draftKey,
              }))
            }
            onMoveUp={() =>
              updateDraftState((current) => ({
                ...current,
                targets: moveDraftTarget(current.targets, target.draftKey, -1),
              }))
            }
            onMoveDown={() =>
              updateDraftState((current) => ({
                ...current,
                targets: moveDraftTarget(current.targets, target.draftKey, 1),
              }))
            }
            onDelete={() =>
              updateDraftState((current) => {
                const nextTargets = current.targets.filter(
                  (candidate) => candidate.draftKey !== target.draftKey,
                );
                return {
                  targets: nextTargets,
                  defaultDraftKey:
                    target.draftKey === current.defaultDraftKey
                      ? (nextTargets[0]?.draftKey ?? null)
                      : current.defaultDraftKey,
                };
              })
            }
          />
        ))}
      </div>
      <div className="settings-open-targets__actions">
        <button
          type="button"
          className="settings-project-card__secondary"
          disabled={saving}
          onClick={() =>
            updateDraftState((current) => {
              const nextTarget = createDraftTarget("app");
              return {
                targets: [...current.targets, nextTarget],
                defaultDraftKey: current.defaultDraftKey ?? nextTarget.draftKey,
              };
            })
          }
        >
          Add target
        </button>
        <button
          type="button"
          className="settings-project-card__secondary"
          disabled={saving || !dirty}
          onClick={handleReset}
        >
          Reset
        </button>
        <button
          type="button"
          className="settings-project-card__primary"
          disabled={
            saving ||
            !dirty ||
            issues.global != null ||
            Object.keys(issues.byKey).length > 0
          }
          onClick={() => void handleSave()}
        >
          Save
        </button>
      </div>
    </div>
  );
}

type RowProps = {
  target: DraftOpenTarget;
  iconUrl?: string | null;
  issue: string | null;
  isDefault: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  disabled: boolean;
  onChange: (patch: Partial<DraftOpenTarget>) => void;
  onSetDefault: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
};

function OpenInTargetRow({
  target,
  iconUrl,
  issue,
  isDefault,
  canMoveUp,
  canMoveDown,
  disabled,
  onChange,
  onSetDefault,
  onMoveUp,
  onMoveDown,
  onDelete,
}: RowProps) {
  const previewTarget: OpenTarget = {
    id: target.id,
    label: target.label,
    kind: target.kind,
    appName: target.appName || null,
    command: target.command || null,
    args: parseArgs(target.argsText),
  };

  return (
    <section className="settings-open-target">
      <div className="settings-open-target__header">
        <span className="settings-open-target__preview" aria-hidden="true">
          <OpenTargetIcon
            target={previewTarget}
            iconUrl={iconUrl}
            size={18}
            className="settings-open-target__preview-icon"
          />
        </span>
        <div className="settings-open-target__header-fields">
          <label className="settings-field">
            <span className="settings-field__label">Label</span>
            <input
              className="settings-field__input"
              type="text"
              value={target.label}
              disabled={disabled}
              placeholder="Cursor"
              onChange={(event) => onChange({ label: event.target.value })}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Kind</span>
            <select
              className="settings-field__input"
              value={target.kind}
              disabled={disabled}
              onChange={(event) =>
                onChange({ kind: event.target.value as OpenTargetKind })
              }
            >
              <option value="app">Application</option>
              <option value="command">Command</option>
              <option value="fileManager">File manager</option>
            </select>
          </label>
        </div>
        <div className="settings-open-target__controls">
          <label className="settings-open-target__default">
            <input
              type="radio"
              checked={isDefault}
              disabled={disabled}
              onChange={onSetDefault}
            />
            <span>Default</span>
          </label>
          <button
            type="button"
            className="settings-project-card__secondary"
            disabled={disabled || !canMoveUp}
            aria-label={`Move ${target.label || "target"} up`}
            onClick={onMoveUp}
          >
            <ArrowUpIcon size={14} />
          </button>
          <button
            type="button"
            className="settings-project-card__secondary"
            disabled={disabled || !canMoveDown}
            aria-label={`Move ${target.label || "target"} down`}
            onClick={onMoveDown}
          >
            <ArrowDownIcon size={14} />
          </button>
          <button
            type="button"
            className="settings-project-card__secondary"
            disabled={disabled}
            aria-label={`Remove ${target.label || "target"}`}
            onClick={onDelete}
          >
            <CloseIcon size={12} />
          </button>
        </div>
      </div>
      <div className="settings-open-target__body">
        {target.kind === "app" ? (
          <label className="settings-field">
            <span className="settings-field__label">Application name</span>
            <input
              className="settings-field__input"
              type="text"
              value={target.appName}
              disabled={disabled}
              placeholder="Cursor"
              onChange={(event) => onChange({ appName: event.target.value })}
            />
          </label>
        ) : null}
        {target.kind === "command" ? (
          <label className="settings-field">
            <span className="settings-field__label">Command</span>
            <input
              className="settings-field__input"
              type="text"
              value={target.command}
              disabled={disabled}
              placeholder="cursor"
              onChange={(event) => onChange({ command: event.target.value })}
            />
          </label>
        ) : null}
        {target.kind !== "fileManager" ? (
          <label className="settings-field">
            <span className="settings-field__label">Arguments</span>
            <textarea
              className="settings-field__textarea"
              value={target.argsText}
              disabled={disabled}
              placeholder="--reuse-window"
              onChange={(event) => onChange({ argsText: event.target.value })}
            />
          </label>
        ) : (
          <div className="settings-open-target__hint">
            <span className="settings-open-target__hint-icon" aria-hidden="true">
              <FolderIcon size={14} />
            </span>
            <p className="settings-field__help">
              Uses the system file manager to open the environment folder.
            </p>
          </div>
        )}
        {issue ? <p className="settings-open-target__error">{issue}</p> : null}
      </div>
    </section>
  );
}
