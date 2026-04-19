import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import type { GlobalSettings, GlobalSettingsPatch } from "../../lib/types";
import { SettingsSwitch } from "./SettingsControls";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

const MIN_MULTI_AGENT_NUDGE_MAX_SUBAGENTS = 1;
const MAX_MULTI_AGENT_NUDGE_MAX_SUBAGENTS = 6;

type Props = {
  disabled: boolean;
  settings: GlobalSettings;
  onChange: (patch: GlobalSettingsPatch) => Promise<void> | void;
};

export function BehaviorSettingsTab({
  disabled,
  settings,
  onChange,
}: Props) {
  return (
    <>
      <SettingsSection title="Conversation">
        <SettingsRow
          title="Collapse work activity"
          description="Hide thinking, tool calls, and sub-agent noise behind one collapsible block."
          control={
            <SettingsSwitch
              label="Collapse work activity"
              disabled={disabled}
              checked={settings.collapseWorkActivity}
              onChange={(value) => onChange({ collapseWorkActivity: value })}
            />
          }
        />
        <SettingsRow
          title="Stream assistant responses"
          description="Stream replies token by token."
          control={
            <SettingsSwitch
              label="Stream assistant responses"
              disabled={disabled}
              checked={settings.streamAssistantResponses}
              onChange={(value) => onChange({ streamAssistantResponses: value })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Multi-agent">
        <SettingsRow
          title="Multi-agent mode"
          description="Nudge Codex to spin up sub-agents when parallel work helps. Soft hint, not a hard cap."
          control={
            <SettingsSwitch
              label="Multi-agent mode"
              disabled={disabled}
              checked={settings.multiAgentNudgeEnabled}
              onChange={(value) => onChange({ multiAgentNudgeEnabled: value })}
            />
          }
        />
        <SettingsRow
          title="Max subagents"
          description="Soft cap for the suggestion — doesn't enforce a runtime limit."
          layout="stacked"
        >
          <SettingsRange
            label="Max subagents"
            min={MIN_MULTI_AGENT_NUDGE_MAX_SUBAGENTS}
            max={MAX_MULTI_AGENT_NUDGE_MAX_SUBAGENTS}
            value={settings.multiAgentNudgeMaxSubagents}
            disabled={!settings.multiAgentNudgeEnabled}
            onChange={(value) => onChange({ multiAgentNudgeMaxSubagents: value })}
          />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

function SettingsRange({
  disabled = false,
  label,
  max,
  min,
  onChange,
  value,
}: {
  disabled?: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  value: number;
}) {
  const inputId = useId();
  const [draftValue, setDraftValue] = useState(value);
  const lastSubmittedValueRef = useRef(value);

  useEffect(() => {
    lastSubmittedValueRef.current = value;
    setDraftValue(value);
  }, [value]);

  function persistDraft(nextValue = draftValue) {
    if (disabled || nextValue === lastSubmittedValueRef.current) {
      return;
    }
    lastSubmittedValueRef.current = nextValue;
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
    <div
      className={`settings-slider ${disabled ? "settings-slider--disabled" : ""}`}
    >
      <div className="settings-slider__header">
        <span />
        <output className="settings-slider__value" htmlFor={inputId}>
          {draftValue}
        </output>
      </div>
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
          aria-label={label}
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
