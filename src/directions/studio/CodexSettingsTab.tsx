import { useEffect, useId, useState } from "react";

import type {
  ApprovalPolicy,
  CollaborationMode,
  GlobalSettings,
  GlobalSettingsPatch,
  ReasoningEffort,
} from "../../lib/types";
import { ComposerPicker, type ComposerPickerOption } from "./ComposerPicker";
import { SettingsToggle } from "./SettingsControls";
import { SettingsUpdateSection } from "./SettingsUpdateSection";
import {
  APPROVAL_OPTIONS,
  COLLABORATION_OPTIONS,
  REASONING_OPTIONS,
  SPEED_MODE_OPTIONS,
} from "./composerOptions";

type Props = {
  disabled: boolean;
  menuZIndex: number;
  modelOptions: ComposerPickerOption[];
  settings: GlobalSettings;
  onChange: (patch: GlobalSettingsPatch) => Promise<void> | void;
};

export function CodexSettingsTab({
  disabled,
  menuZIndex,
  modelOptions,
  settings,
  onChange,
}: Props) {
  return (
    <div className="settings-list">
      <SettingsSelect
        disabled={disabled}
        label="Default model"
        value={settings.defaultModel}
        options={modelOptions}
        menuZIndex={menuZIndex}
        onChange={(value) => onChange({ defaultModel: value })}
      />
      <SettingsSelect
        disabled={disabled}
        label="Default reasoning"
        value={settings.defaultReasoningEffort}
        options={REASONING_OPTIONS}
        menuZIndex={menuZIndex}
        onChange={(value) =>
          onChange({ defaultReasoningEffort: value as ReasoningEffort })
        }
      />
      <SettingsSelect
        disabled={disabled}
        label="Default mode"
        value={settings.defaultCollaborationMode}
        options={COLLABORATION_OPTIONS}
        menuZIndex={menuZIndex}
        onChange={(value) =>
          onChange({ defaultCollaborationMode: value as CollaborationMode })
        }
      />
      <SettingsSelect
        disabled={disabled}
        label="Default approval"
        value={settings.defaultApprovalPolicy}
        options={APPROVAL_OPTIONS}
        menuZIndex={menuZIndex}
        onChange={(value) =>
          onChange({ defaultApprovalPolicy: value as ApprovalPolicy })
        }
      />
      <SettingsSelect
        disabled={disabled}
        label="Default speed"
        value={settings.defaultServiceTier ?? "flex"}
        options={SPEED_MODE_OPTIONS}
        menuZIndex={menuZIndex}
        onChange={(value) => onChange({ defaultServiceTier: value })}
      />
      <SettingsToggle
        disabled={disabled}
        label="Collapse work activity"
        description="Hide intermediate thinking, tool calls, task progress, and subagent noise behind one collapsible work block. Plans and user interactions stay visible."
        checked={settings.collapseWorkActivity}
        onChange={(value) => onChange({ collapseWorkActivity: value })}
      />
      <SettingsInput
        disabled={disabled}
        label="Codex binary"
        value={settings.codexBinaryPath ?? ""}
        placeholder="auto-detect"
        onChange={(value) => onChange({ codexBinaryPath: value || null })}
      />
      <SettingsUpdateSection disabled={disabled} />
    </div>
  );
}

function SettingsSelect<T extends string>({
  disabled = false,
  label,
  menuZIndex,
  onChange,
  options,
  value,
}: {
  disabled?: boolean;
  label: string;
  menuZIndex: number;
  onChange: (value: T) => void;
  options: ComposerPickerOption<T>[];
  value: T;
}) {
  return (
    <ComposerPicker
      label={label}
      value={value}
      options={options}
      disabled={disabled}
      menuZIndex={menuZIndex}
      onChange={(nextValue) => onChange(nextValue as T)}
    />
  );
}

function SettingsInput({
  disabled = false,
  label,
  onChange,
  placeholder,
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const inputId = useId();

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className="settings-field__input"
        type="text"
        value={draftValue}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => setDraftValue(event.target.value)}
        onBlur={(event) => {
          const nextValue = event.target.value;
          if (nextValue !== value) {
            onChange(nextValue);
          }
        }}
      />
    </div>
  );
}
