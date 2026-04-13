type SettingsToggleProps = {
  label: string;
  description: string;
  supportText?: string;
  notice?: string | null;
  noticeTone?: "default" | "error";
  disabled?: boolean;
  checked: boolean;
  onChange: (value: boolean) => void;
};

type SettingsSwitchProps = {
  label: string;
  disabled?: boolean;
  checked: boolean;
  onChange: (value: boolean) => void;
};

export function SettingsSwitch({
  label,
  disabled = false,
  checked,
  onChange,
}: SettingsSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      disabled={disabled}
      aria-checked={checked}
      aria-label={label}
      className={`settings-toggle__control ${
        checked ? "settings-toggle__control--checked" : ""
      }`}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle__thumb" />
    </button>
  );
}

export function SettingsToggle({
  label,
  description,
  supportText,
  notice,
  noticeTone = "default",
  disabled = false,
  checked,
  onChange,
}: SettingsToggleProps) {
  return (
    <div className="settings-toggle">
      <div className="settings-toggle__copy">
        <label className="settings-field__label">{label}</label>
        <p className="settings-field__help">{description}</p>
        {supportText ? <p className="settings-field__help">{supportText}</p> : null}
        {notice ? (
          <p
            className={`settings-field__help ${
              noticeTone === "error" ? "settings-field__help--error" : ""
            }`}
          >
            {notice}
          </p>
        ) : null}
      </div>
      <SettingsSwitch
        label={label}
        disabled={disabled}
        checked={checked}
        onChange={onChange}
      />
    </div>
  );
}
