import { MoonIcon, SettingsIcon, SunIcon } from "../../shared/Icons";
import type { Theme } from "./StudioShell";
import "./SidebarUtilityActions.css";

type Props = {
  theme: Theme;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
};

export function SidebarUtilityActions({
  theme,
  onOpenSettings,
  onToggleTheme,
}: Props) {
  const themeLabel = theme === "dark" ? "Light mode" : "Dark mode";

  return (
    <div className="sidebar-utility-actions" aria-label="Sidebar actions">
      <button
        type="button"
        className="sidebar-utility-actions__button"
        onClick={onOpenSettings}
      >
        <span className="sidebar-utility-actions__icon">
          <SettingsIcon size={16} />
        </span>
        <span>Settings</span>
      </button>
      <button
        type="button"
        className="sidebar-utility-actions__button"
        onClick={onToggleTheme}
      >
        <span className="sidebar-utility-actions__icon">
          {theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        </span>
        <span>{themeLabel}</span>
      </button>
    </div>
  );
}
