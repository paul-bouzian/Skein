import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

import * as bridge from "../../lib/bridge";
import type {
  ApprovalPolicy,
  CollaborationMode,
  GlobalSettings,
  GlobalSettingsPatch,
  ReasoningEffort,
} from "../../lib/types";
import { ProjectSettingsTab } from "./ProjectSettingsTab";
import { OpenInSettingsTab } from "./OpenInSettingsTab";
import { ShortcutsSettingsTab } from "./ShortcutsSettingsTab";
import { SettingsUpdateSection } from "./SettingsUpdateSection";
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
import { ComposerPicker, type ComposerPickerOption } from "./ComposerPicker";
import {
  APPROVAL_OPTIONS,
  COLLABORATION_OPTIONS,
  REASONING_OPTIONS,
  SPEED_MODE_OPTIONS,
  settingsModelOptions,
} from "./composerOptions";
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
type SettingsTab = "codex" | "openIn" | "shortcuts" | "project";

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
              <SettingsContent
                settings={settings}
                disabled={savingGlobalSettings}
                desktopNotificationsBusy={desktopNotificationsBusy}
                desktopNotificationsNotice={desktopNotificationsNotice}
                modelOptions={modelOptions}
                onChange={handleGlobalChange}
                onDesktopNotificationsChange={handleDesktopNotificationsChange}
              />
            ) : null}
            {activeTab === "codex" && !settings ? (
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

function SettingsContent({
  settings,
  disabled,
  desktopNotificationsBusy,
  desktopNotificationsNotice,
  modelOptions,
  onChange,
  onDesktopNotificationsChange,
}: {
  settings: GlobalSettings;
  disabled: boolean;
  desktopNotificationsBusy: boolean;
  desktopNotificationsNotice: string | null;
  modelOptions: ComposerPickerOption[];
  onChange: (patch: GlobalSettingsPatch) => Promise<void> | void;
  onDesktopNotificationsChange: (enabled: boolean) => Promise<void>;
}) {
  return (
    <div className="settings-list">
      <SettingsSelect
        disabled={disabled}
        label="Default model"
        value={settings.defaultModel}
        options={modelOptions}
        onChange={(value) => onChange({ defaultModel: value })}
      />
      <SettingsSelect
        disabled={disabled}
        label="Default reasoning"
        value={settings.defaultReasoningEffort}
        options={REASONING_OPTIONS}
        onChange={(value) =>
          onChange({ defaultReasoningEffort: value as ReasoningEffort })
        }
      />
      <SettingsSelect
        disabled={disabled}
        label="Default mode"
        value={settings.defaultCollaborationMode}
        options={COLLABORATION_OPTIONS}
        onChange={(value) =>
          onChange({ defaultCollaborationMode: value as CollaborationMode })
        }
      />
      <SettingsSelect
        disabled={disabled}
        label="Default approval"
        value={settings.defaultApprovalPolicy}
        options={APPROVAL_OPTIONS}
        onChange={(value) =>
          onChange({ defaultApprovalPolicy: value as ApprovalPolicy })
        }
      />
      <SettingsSelect
        disabled={disabled}
        label="Default speed"
        value={settings.defaultServiceTier ?? "flex"}
        options={SPEED_MODE_OPTIONS}
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
        disabled={disabled || desktopNotificationsBusy}
        label="Desktop notifications"
        description="Show an OS notification when a chat finishes or needs input while the app is in the background."
        supportText="Desktop app notifications use your operating system notification center."
        notice={desktopNotificationsNotice}
        noticeTone="error"
        checked={settings.desktopNotificationsEnabled}
        onChange={(value) => void onDesktopNotificationsChange(value)}
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
  label,
  disabled = false,
  value,
  options,
  onChange,
}: {
  label: string;
  disabled?: boolean;
  value: T;
  options: ComposerPickerOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <ComposerPicker
      label={label}
      value={value}
      options={options}
      disabled={disabled}
      menuZIndex={SETTINGS_PICKER_Z_INDEX}
      onChange={(nextValue) => onChange(nextValue as T)}
    />
  );
}

function SettingsInput({
  label,
  disabled = false,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  disabled?: boolean;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <div className="settings-field">
      <label className="settings-field__label">{label}</label>
      <input
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

function SettingsToggle({
  label,
  description,
  supportText,
  notice,
  noticeTone = "default",
  disabled = false,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  supportText?: string;
  notice?: string | null;
  noticeTone?: "default" | "error";
  disabled?: boolean;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
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
    </div>
  );
}
