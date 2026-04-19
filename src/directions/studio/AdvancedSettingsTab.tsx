import { useEffect, useId, useState } from "react";

import type { GlobalSettings, GlobalSettingsPatch } from "../../lib/types";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import { SettingsUpdateSection } from "./SettingsUpdateSection";

type Props = {
  disabled: boolean;
  settings: GlobalSettings;
  onChange: (patch: GlobalSettingsPatch) => Promise<void> | void;
};

export function AdvancedSettingsTab({ disabled, settings, onChange }: Props) {
  return (
    <>
      <SettingsSection title="System">
        <SettingsRow
          title="Codex binary"
          description="Path to the Codex CLI. Leave blank for auto-detect."
          layout="stacked"
        >
          <SettingsInput
            label="Codex binary"
            value={settings.codexBinaryPath ?? ""}
            placeholder="auto-detect"
            disabled={disabled}
            onChange={(value) =>
              onChange({ codexBinaryPath: value.trim() === "" ? null : value })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Updates">
        <SettingsRow
          title="App updates"
          description="Check and install the latest Skein release without leaving the app."
          layout="stacked"
        >
          <SettingsUpdateSection disabled={disabled} />
        </SettingsRow>
      </SettingsSection>
    </>
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
    <input
      id={inputId}
      className="settings-field__input"
      type="text"
      aria-label={label}
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
  );
}
