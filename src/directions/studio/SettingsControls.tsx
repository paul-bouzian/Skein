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
