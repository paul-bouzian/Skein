import type {
  ApprovalPolicy,
  CollaborationMode,
  GlobalSettings,
  GlobalSettingsPatch,
  ReasoningEffort,
} from "../../lib/types";
import { ComposerPicker, type ComposerPickerOption } from "./ComposerPicker";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
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

export function GeneralSettingsTab({
  disabled,
  menuZIndex,
  modelOptions,
  settings,
  onChange,
}: Props) {
  return (
    <SettingsSection
      title="Defaults"
      description="Applied to every new thread. You can override them per thread from the composer."
    >
      <SettingsRow
        title="Model"
        description="Default model for new threads."
        control={
          <SettingsSelect
            label="Default model"
            value={settings.defaultModel}
            options={modelOptions}
            disabled={disabled}
            menuZIndex={menuZIndex}
            onChange={(value) => onChange({ defaultModel: value })}
          />
        }
      />
      <SettingsRow
        title="Reasoning"
        description="How much thinking Codex does before replying."
        control={
          <SettingsSelect
            label="Default reasoning"
            value={settings.defaultReasoningEffort}
            options={REASONING_OPTIONS}
            disabled={disabled}
            menuZIndex={menuZIndex}
            onChange={(value) =>
              onChange({ defaultReasoningEffort: value as ReasoningEffort })
            }
          />
        }
      />
      <SettingsRow
        title="Mode"
        description="Start new threads in Build or Plan."
        control={
          <SettingsSelect
            label="Default mode"
            value={settings.defaultCollaborationMode}
            options={COLLABORATION_OPTIONS}
            disabled={disabled}
            menuZIndex={menuZIndex}
            onChange={(value) =>
              onChange({ defaultCollaborationMode: value as CollaborationMode })
            }
          />
        }
      />
      <SettingsRow
        title="Approval"
        description="Whether Codex asks before editing files."
        control={
          <SettingsSelect
            label="Default approval"
            value={settings.defaultApprovalPolicy}
            options={APPROVAL_OPTIONS}
            disabled={disabled}
            menuZIndex={menuZIndex}
            onChange={(value) =>
              onChange({ defaultApprovalPolicy: value as ApprovalPolicy })
            }
          />
        }
      />
      <SettingsRow
        title="Speed"
        description="Service tier used for new turns."
        control={
          <SettingsSelect
            label="Default speed"
            value={settings.defaultServiceTier ?? "flex"}
            options={SPEED_MODE_OPTIONS}
            disabled={disabled}
            menuZIndex={menuZIndex}
            onChange={(value) => onChange({ defaultServiceTier: value })}
          />
        }
      />
    </SettingsSection>
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
      compact
      disabled={disabled}
      menuZIndex={menuZIndex}
      onChange={(nextValue) => onChange(nextValue as T)}
    />
  );
}
