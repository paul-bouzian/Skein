import { useEffect, useMemo, useRef, useState } from "react";

import type { OpenTarget } from "../../lib/types";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { ArrowDownIcon, ArrowUpIcon } from "../../shared/Icons";
import { OpenTargetIcon } from "./OpenTargetIcon";
import {
  buildDraftState,
  matchesPersistedTargets,
  moveDraftTarget,
  persistedOpenInSettingsEqual,
  persistDraftTargets,
  validateDraftTargets,
  type OpenInDraftState,
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
  const lastPersistedTargetsRef = useRef(targets);
  const lastDefaultTargetIdRef = useRef(defaultTargetId);

  useEffect(() => {
    if (
      persistedOpenInSettingsEqual(
        lastPersistedTargetsRef.current,
        lastDefaultTargetIdRef.current,
        targets,
        defaultTargetId,
      )
    ) {
      return;
    }

    lastPersistedTargetsRef.current = targets;
    lastDefaultTargetIdRef.current = defaultTargetId;
    setDraftState(buildDraftState(targets, defaultTargetId));
    setSaving(false);
  }, [defaultTargetId, targets]);

  const issues = useMemo(
    () => validateDraftTargets(draftState.targets, draftState.defaultDraftKey),
    [draftState.defaultDraftKey, draftState.targets],
  );
  const dirty = useMemo(
    () =>
      !matchesPersistedTargets(
        draftState.targets,
        draftState.defaultDraftKey,
        targets,
        defaultTargetId,
      ),
    [defaultTargetId, draftState.defaultDraftKey, draftState.targets, targets],
  );
  const noticeMessage = saveError ?? issues.global;

  async function handleSave() {
    if (issues.global) {
      setSaveError(issues.global);
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
          Reorder the curated Open In targets shown in the toolbar menu and pick
          the default action for the primary button.
        </p>
      </div>
      {noticeMessage ? (
        <p className="settings-dialog__notice">{noticeMessage}</p>
      ) : null}
      <fieldset className="settings-open-targets__list">
        <legend className="settings-open-targets__legend">
          Default Open In target
        </legend>
        {draftState.targets.map(({ draftKey, target }, index) => (
          <OpenInTargetRow
            key={draftKey}
            target={target}
            isDefault={draftKey === draftState.defaultDraftKey}
            canMoveUp={index > 0}
            canMoveDown={index < draftState.targets.length - 1}
            disabled={saving}
            onSetDefault={() =>
              updateDraftState((current) => ({
                ...current,
                defaultDraftKey: draftKey,
              }))
            }
            onMoveUp={() =>
              updateDraftState((current) => ({
                ...current,
                targets: moveDraftTarget(current.targets, draftKey, -1),
              }))
            }
            onMoveDown={() =>
              updateDraftState((current) => ({
                ...current,
                targets: moveDraftTarget(current.targets, draftKey, 1),
              }))
            }
          />
        ))}
      </fieldset>
      <div className="settings-open-targets__actions">
        <button
          type="button"
          className="tx-action-btn tx-action-btn--secondary"
          disabled={saving || !dirty}
          onClick={handleReset}
        >
          Reset
        </button>
        <button
          type="button"
          className="tx-action-btn tx-action-btn--primary"
          disabled={saving || !dirty || issues.global != null}
          onClick={() => void handleSave()}
        >
          Save
        </button>
      </div>
    </div>
  );
}

type RowProps = {
  target: OpenTarget;
  isDefault: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  disabled: boolean;
  onSetDefault: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
};

function OpenInTargetRow({
  target,
  isDefault,
  canMoveUp,
  canMoveDown,
  disabled,
  onSetDefault,
  onMoveUp,
  onMoveDown,
}: RowProps) {
  return (
    <section className="settings-open-target">
      <div className="settings-open-target__header">
        <span className="settings-open-target__preview" aria-hidden="true">
          <OpenTargetIcon
            target={target}
            size={18}
            className="settings-open-target__preview-icon"
          />
        </span>
        <div className="settings-open-target__header-fields">
          <span className="settings-field__label">{target.label}</span>
          <p className="settings-field__help">{describeTarget(target)}</p>
        </div>
        <div className="settings-open-target__controls">
          <label className="settings-open-target__default">
            <input
              type="radio"
              name="open-in-default-target"
              checked={isDefault}
              disabled={disabled}
              onChange={onSetDefault}
            />
            <span>Default</span>
          </label>
          <button
            type="button"
            className="tx-action-btn tx-action-btn--secondary"
            disabled={disabled || !canMoveUp}
            aria-label={`Move ${target.label} up`}
            onClick={onMoveUp}
          >
            <ArrowUpIcon size={14} />
          </button>
          <button
            type="button"
            className="tx-action-btn tx-action-btn--secondary"
            disabled={disabled || !canMoveDown}
            aria-label={`Move ${target.label} down`}
            onClick={onMoveDown}
          >
            <ArrowDownIcon size={14} />
          </button>
        </div>
      </div>
    </section>
  );
}

function describeTarget(target: OpenTarget) {
  if (target.kind === "fileManager") {
    return "Uses the system file manager to open the environment folder.";
  }

  return target.appName
    ? `Launches ${target.appName}.`
    : "Launches the selected application.";
}
