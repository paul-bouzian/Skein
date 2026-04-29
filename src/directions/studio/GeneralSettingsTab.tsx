import type {
  ApprovalPolicy,
  CollaborationMode,
  DefaultDraftEnvironment,
  GlobalSettings,
  GlobalSettingsPatch,
  ModelOption,
  ProviderKind,
  ReasoningEffort,
} from "../../lib/types";
import { ComposerPicker, type ComposerPickerOption } from "./ComposerPicker";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import {
  APPROVAL_OPTIONS,
  COLLABORATION_OPTIONS,
  DRAFT_ENVIRONMENT_OPTIONS,
  PROVIDER_OPTIONS,
  REASONING_OPTIONS,
  SPEED_MODE_OPTIONS,
  reasoningOptionsFor,
  settingsModelOptions,
} from "./composerOptions";

type Props = {
  disabled: boolean;
  menuZIndex: number;
  models: ModelOption[];
  settings: GlobalSettings;
  onChange: (patch: GlobalSettingsPatch) => Promise<void> | void;
};

export function GeneralSettingsTab({
  disabled,
  menuZIndex,
  models,
  settings,
  onChange,
}: Props) {
  const modelOptions = settingsModelOptions(
    models,
    settings.defaultModel,
    settings.defaultProvider,
  );
  const selectedModel = models.find(
    (model) =>
      model.id === settings.defaultModel &&
      (model.provider ?? "codex") === settings.defaultProvider,
  );
  const reasoningOptions =
    selectedModel?.supportedReasoningEfforts.length
      ? reasoningOptionsFor(selectedModel.supportedReasoningEfforts)
      : REASONING_OPTIONS;

  return (
    <SettingsSection
      title="Defaults"
      description="Applied to every new thread. You can override them per thread from the composer."
    >
      <SettingsRow
        title="Provider"
        description="Default provider for new threads."
        control={
          <SettingsSelect
            label="Default provider"
            value={settings.defaultProvider}
            options={PROVIDER_OPTIONS}
            disabled={disabled}
            menuZIndex={menuZIndex}
            onChange={(value) => {
              const provider = value as ProviderKind;
              const model = defaultModelForProvider(provider, models);
              const modelOption = models.find(
                (candidate) =>
                  candidate.id === model &&
                  (candidate.provider ?? "codex") === provider,
              );
              onChange({
                defaultProvider: provider,
                defaultModel: model,
                defaultReasoningEffort:
                  modelOption?.defaultReasoningEffort ?? "medium",
              });
            }}
          />
        }
      />
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
            onChange={(value) => {
              const model = models.find(
                (candidate) =>
                  candidate.id === value &&
                  (candidate.provider ?? "codex") === settings.defaultProvider,
              );
              onChange({
                defaultModel: value,
                ...(model?.defaultReasoningEffort
                  ? { defaultReasoningEffort: model.defaultReasoningEffort }
                  : {}),
              });
            }}
          />
        }
      />
      <SettingsRow
        title="Reasoning"
        description="How much thinking the selected provider does before replying."
        control={
          <SettingsSelect
            label="Default reasoning"
            value={settings.defaultReasoningEffort}
            options={reasoningOptions}
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
        title="Environment"
        description="Default destination for new project draft threads."
        control={
          <SettingsSelect
            label="Default environment"
            value={settings.defaultDraftEnvironment}
            options={DRAFT_ENVIRONMENT_OPTIONS}
            disabled={disabled}
            menuZIndex={menuZIndex}
            onChange={(value) =>
              onChange({
                defaultDraftEnvironment: value as DefaultDraftEnvironment,
              })
            }
          />
        }
      />
      <SettingsRow
        title="Approval"
        description="Whether the agent asks before editing files."
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

function defaultModelForProvider(
  provider: ProviderKind,
  models: ModelOption[],
): string {
  const scoped = models.filter(
    (model) => (model.provider ?? "codex") === provider,
  );
  return (
    scoped.find((model) => model.isDefault)?.id ??
    scoped[0]?.id ??
    (provider === "claude" ? "claude-sonnet-4-6" : "gpt-5.4")
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
