import {
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

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

const MIN_MULTI_AGENT_NUDGE_MAX_SUBAGENTS = 1;
const MAX_MULTI_AGENT_NUDGE_MAX_SUBAGENTS = 6;

type Props = {
  disabled: boolean;
  menuZIndex: number;
  modelOptions: ComposerPickerOption[];
  rangeDisabled?: boolean;
  settings: GlobalSettings;
  onChange: (patch: GlobalSettingsPatch) => Promise<void> | void;
};

export function CodexSettingsTab({
  disabled,
  menuZIndex,
  modelOptions,
  rangeDisabled = false,
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
      <SettingsToggle
        disabled={disabled}
        label="Stream assistant responses"
        description="Stream assistant replies token by token in real time."
        checked={settings.streamAssistantResponses}
        onChange={(value) => onChange({ streamAssistantResponses: value })}
      />
      <SettingsToggle
        disabled={disabled}
        label="Multi-agent mode"
        description="Add an invisible instruction to each user prompt that encourages Codex to use sub-agents when they would clearly improve speed or quality."
        supportText="This nudges Codex toward parallel work without forcing sub-agent usage."
        checked={settings.multiAgentNudgeEnabled}
        onChange={(value) => onChange({ multiAgentNudgeEnabled: value })}
      />
      <SettingsRange
        disabled={rangeDisabled || !settings.multiAgentNudgeEnabled}
        label="Max subagents"
        description="Choose how many sub-agents Skein may suggest in that invisible instruction. This is a soft hint, not a hard runtime cap."
        min={MIN_MULTI_AGENT_NUDGE_MAX_SUBAGENTS}
        max={MAX_MULTI_AGENT_NUDGE_MAX_SUBAGENTS}
        value={settings.multiAgentNudgeMaxSubagents}
        onChange={(value) => onChange({ multiAgentNudgeMaxSubagents: value })}
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

function SettingsRange({
  description,
  disabled = false,
  label,
  max,
  min,
  onChange,
  value,
}: {
  description: string;
  disabled?: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  value: number;
}) {
  const inputId = useId();
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  function persistDraft(nextValue = draftValue) {
    if (disabled || nextValue === value) {
      return;
    }
    onChange(nextValue);
  }

  function updateDraft(nextValue: number) {
    setDraftValue(Math.min(max, Math.max(min, nextValue)));
  }

  function handleKeyUp(event: KeyboardEvent<HTMLInputElement>) {
    if (
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight" ||
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "Home" ||
      event.key === "End" ||
      event.key === "PageUp" ||
      event.key === "PageDown"
    ) {
      persistDraft();
    }
  }

  const tickCount = max - min + 1;
  const progress = ((draftValue - min) / (max - min)) * 100;

  return (
    <div className={`settings-slider ${disabled ? "settings-slider--disabled" : ""}`}>
      <div className="settings-slider__header">
        <label className="settings-field__label" htmlFor={inputId}>
          {label}
        </label>
        <output className="settings-slider__value" htmlFor={inputId}>
          {draftValue}
        </output>
      </div>
      <p className="settings-field__help">{description}</p>
      <div className="settings-slider__track">
        <div className="settings-slider__ticks" aria-hidden="true">
          {Array.from({ length: tickCount }).map((_, index) => {
            const stepValue = min + index;
            const isActive = stepValue <= draftValue;
            return (
              <span
                key={stepValue}
                className={`settings-slider__tick ${
                  isActive ? "settings-slider__tick--active" : ""
                }`}
              />
            );
          })}
        </div>
        <input
          id={inputId}
          className="settings-slider__input"
          type="range"
          min={min}
          max={max}
          step={1}
          disabled={disabled}
          value={draftValue}
          style={{ "--settings-slider-progress": `${progress}%` } as CSSProperties}
          onChange={(event) => updateDraft(Number(event.target.value))}
          onBlur={() => persistDraft()}
          onPointerUp={() => persistDraft()}
          onKeyUp={handleKeyUp}
        />
      </div>
      <div className="settings-slider__scale" aria-hidden="true">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}
