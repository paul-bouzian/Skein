import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

import * as bridge from "../../lib/bridge";
import type { GlobalSettingsPatch } from "../../lib/types";
import { CodexSettingsTab } from "./CodexSettingsTab";
import { ProjectSettingsTab } from "./ProjectSettingsTab";
import { OpenInSettingsTab } from "./OpenInSettingsTab";
import { ShortcutsSettingsTab } from "./ShortcutsSettingsTab";
import { NotificationsSettingsTab } from "./NotificationsSettingsTab";
import {
  selectConversationCapabilities,
  useConversationStore,
} from "../../stores/conversation-store";
import {
  selectProjects,
  selectSettings,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { CloseIcon } from "../../shared/Icons";
import { settingsModelOptions } from "./composerOptions";
import "./SettingsDialog.css";

type Props = {
  open: boolean;
  onClose: () => void;
};

const SETTINGS_PICKER_Z_INDEX = 1310;
const SETTINGS_REFRESH_ERROR =
  "Settings were saved, but the workspace snapshot could not be refreshed.";
const DESKTOP_NOTIFICATIONS_ENABLE_ERROR =
  "Desktop notifications could not be enabled. Check your operating system notification permissions and try again.";
const DESKTOP_NOTIFICATIONS_PERMISSION_DENIED =
  "Desktop notifications were not enabled because permission was denied by the operating system.";
type SettingsTab = "codex" | "notifications" | "openIn" | "shortcuts" | "project";

async function requestDesktopNotificationsAccess(): Promise<
  "granted" | "denied" | "error"
> {
  try {
    if (await isPermissionGranted()) {
      return "granted";
    }

    return (await requestPermission()) === "granted" ? "granted" : "denied";
  } catch {
    return "error";
  }
}

export function SettingsDialog({ open, onClose }: Props) {
  const settings = useWorkspaceStore(selectSettings);
  const projects = useWorkspaceStore(selectProjects);
  const selectedProjectId = useWorkspaceStore((state) => state.selectedProjectId);
  const selectedEnvironmentId = useWorkspaceStore(
    (state) => state.selectedEnvironmentId,
  );
  const capabilities = useConversationStore(
    selectConversationCapabilities(selectedEnvironmentId),
  );
  const refreshSnapshot = useWorkspaceStore((state) => state.refreshSnapshot);
  const updateGlobalSettings = useWorkspaceStore((state) => state.updateGlobalSettings);
  const [actionError, setActionError] = useState<string | null>(null);
  const [desktopNotificationsNotice, setDesktopNotificationsNotice] = useState<
    string | null
  >(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("codex");
  const [savingGlobalSettings, setSavingGlobalSettings] = useState(false);
  const [desktopNotificationsBusy, setDesktopNotificationsBusy] = useState(false);
  const savingGlobalSettingsRef = useRef(false);
  const desktopNotificationsBusyRef = useRef(false);
  const modelOptions = useMemo(
    () =>
      settings
        ? settingsModelOptions(capabilities?.models ?? [], settings.defaultModel)
        : [],
    [capabilities?.models, settings],
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      queueMicrotask(() => {
        if (event.defaultPrevented) {
          return;
        }

        event.preventDefault();
        onClose();
      });
    }

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setActionError(null);
      setDesktopNotificationsNotice(null);
      setActiveTab("codex");
    }
  }, [open]);

  async function refreshWorkspaceOrThrow() {
    const refreshed = await refreshSnapshot();
    if (!refreshed) {
      throw new Error(SETTINGS_REFRESH_ERROR);
    }
  }

  async function applyGlobalSettingsChange(patch: GlobalSettingsPatch) {
    try {
      setActionError(null);
      const result = await updateGlobalSettings(patch);
      if (!result.ok) {
        throw new Error(result.errorMessage ?? "Failed to save settings");
      }
      if (result.warningMessage) {
        setActionError(result.warningMessage);
      }
    } catch (cause: unknown) {
      setActionError(
        cause instanceof Error ? cause.message : "Failed to save settings",
      );
    }
  }

  async function handleGlobalChange(patch: GlobalSettingsPatch) {
    if (savingGlobalSettingsRef.current) {
      return;
    }

    savingGlobalSettingsRef.current = true;
    setSavingGlobalSettings(true);
    try {
      await applyGlobalSettingsChange(patch);
    } finally {
      savingGlobalSettingsRef.current = false;
      setSavingGlobalSettings(false);
    }
  }

  async function handleDesktopNotificationsChange(nextValue: boolean) {
    if (desktopNotificationsBusyRef.current || savingGlobalSettingsRef.current) {
      return;
    }

    desktopNotificationsBusyRef.current = true;
    savingGlobalSettingsRef.current = true;
    setDesktopNotificationsBusy(true);
    setSavingGlobalSettings(true);
    setActionError(null);
    setDesktopNotificationsNotice(null);

    try {
      if (!nextValue) {
        await applyGlobalSettingsChange({ desktopNotificationsEnabled: false });
        return;
      }

      const permissionState = await requestDesktopNotificationsAccess();
      if (permissionState === "error") {
        setDesktopNotificationsNotice(DESKTOP_NOTIFICATIONS_ENABLE_ERROR);
        return;
      }
      if (permissionState === "denied") {
        setDesktopNotificationsNotice(DESKTOP_NOTIFICATIONS_PERMISSION_DENIED);
        return;
      }

      await applyGlobalSettingsChange({ desktopNotificationsEnabled: true });
    } finally {
      savingGlobalSettingsRef.current = false;
      desktopNotificationsBusyRef.current = false;
      setSavingGlobalSettings(false);
      setDesktopNotificationsBusy(false);
    }
  }

  async function handleProjectSave(
    projectId: string,
    patch: {
      worktreeSetupScript?: string | null;
      worktreeTeardownScript?: string | null;
    },
  ) {
    setActionError(null);

    try {
      await bridge.updateProjectSettings({ projectId, patch });
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to save project settings";
      setActionError(message);
      throw cause;
    }

    try {
      await refreshWorkspaceOrThrow();
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to save project settings";
      setActionError(message);
    }
  }

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="settings-dialog__backdrop" onClick={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-dialog__header">
          <h2 id="settings-dialog-title" className="settings-dialog__title">
            Settings
          </h2>
          <button
            type="button"
            className="settings-dialog__close"
            onClick={onClose}
            aria-label="Close settings"
            title="Close settings"
          >
            <CloseIcon size={12} />
          </button>
        </div>

        <div className="settings-dialog__layout">
          <div
            className="settings-dialog__sidebar"
            role="navigation"
            aria-label="Settings sections"
          >
            <button
              type="button"
              className={`settings-dialog__tab ${
                activeTab === "codex" ? "settings-dialog__tab--active" : ""
              }`}
              aria-current={activeTab === "codex" ? "page" : undefined}
              onClick={() => setActiveTab("codex")}
            >
              Codex
            </button>
            <button
              type="button"
              className={`settings-dialog__tab ${
                activeTab === "notifications" ? "settings-dialog__tab--active" : ""
              }`}
              aria-current={activeTab === "notifications" ? "page" : undefined}
              onClick={() => setActiveTab("notifications")}
            >
              Notifications
            </button>
            <button
              type="button"
              className={`settings-dialog__tab ${
                activeTab === "openIn" ? "settings-dialog__tab--active" : ""
              }`}
              aria-current={activeTab === "openIn" ? "page" : undefined}
              onClick={() => setActiveTab("openIn")}
            >
              Open In
            </button>
            <button
              type="button"
              className={`settings-dialog__tab ${
                activeTab === "shortcuts" ? "settings-dialog__tab--active" : ""
              }`}
              aria-current={activeTab === "shortcuts" ? "page" : undefined}
              onClick={() => setActiveTab("shortcuts")}
            >
              Shortcuts
            </button>
            <button
              type="button"
              className={`settings-dialog__tab ${
                activeTab === "project" ? "settings-dialog__tab--active" : ""
              }`}
              aria-current={activeTab === "project" ? "page" : undefined}
              onClick={() => setActiveTab("project")}
            >
              Project
            </button>
          </div>
          <div className="settings-dialog__body">
            {actionError ? (
              <p className="settings-dialog__notice">{actionError}</p>
            ) : null}
            {activeTab === "codex" && settings ? (
              <CodexSettingsTab
                disabled={savingGlobalSettings}
                menuZIndex={SETTINGS_PICKER_Z_INDEX}
                modelOptions={modelOptions}
                settings={settings}
                onChange={handleGlobalChange}
              />
            ) : null}
            {activeTab === "codex" && !settings ? (
              <p className="settings-dialog__empty">Loading...</p>
            ) : null}
            {activeTab === "notifications" && settings ? (
              <NotificationsSettingsTab
                settings={settings}
                disabled={savingGlobalSettings}
                desktopNotificationsBusy={desktopNotificationsBusy}
                desktopNotificationsNotice={desktopNotificationsNotice}
                menuZIndex={SETTINGS_PICKER_Z_INDEX}
                onChange={handleGlobalChange}
                onDesktopNotificationsChange={handleDesktopNotificationsChange}
              />
            ) : null}
            {activeTab === "notifications" && !settings ? (
              <p className="settings-dialog__empty">Loading...</p>
            ) : null}
            {activeTab === "shortcuts" && settings ? (
              <ShortcutsSettingsTab
                shortcuts={settings.shortcuts}
                disabled={savingGlobalSettings}
                onChange={(shortcuts) => handleGlobalChange({ shortcuts })}
              />
            ) : null}
            {activeTab === "shortcuts" && !settings ? (
              <p className="settings-dialog__empty">Loading...</p>
            ) : null}
            {activeTab === "openIn" && settings ? (
              <OpenInSettingsTab
                targets={settings.openTargets}
                defaultTargetId={settings.defaultOpenTargetId}
              />
            ) : null}
            {activeTab === "openIn" && !settings ? (
              <p className="settings-dialog__empty">Loading...</p>
            ) : null}
            {activeTab === "project" ? (
              <ProjectSettingsTab
                projects={projects}
                selectedProjectId={selectedProjectId}
                onSave={handleProjectSave}
              />
            ) : (
              null
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
