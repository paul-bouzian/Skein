import { useEffect, useMemo, useRef, useState } from "react";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

import { AdvancedSettingsTab } from "./AdvancedSettingsTab";
import { BehaviorSettingsTab } from "./BehaviorSettingsTab";
import { GeneralSettingsTab } from "./GeneralSettingsTab";
import type {
  GlobalSettingsPatch,
  ProjectRecord,
  ProjectSettingsPatch,
} from "../../lib/types";
import { ProjectSettingsTab } from "./ProjectSettingsTab";
import { OpenInSettingsTab } from "./OpenInSettingsTab";
import { ShortcutsSettingsTab } from "./ShortcutsSettingsTab";
import { NotificationsSettingsTab } from "./NotificationsSettingsTab";
import {
  selectConversationCapabilities,
  useConversationStore,
} from "../../stores/conversation-store";
import {
  findPrimaryEnvironment,
  selectProjects,
  selectSettings,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { ArrowLeftIcon } from "../../shared/Icons";
import { settingsModelOptions } from "./composerOptions";
import "./SettingsView.css";

type Props = {
  open: boolean;
  onClose: () => void;
};

const SETTINGS_PICKER_Z_INDEX = 1310;
const DESKTOP_NOTIFICATIONS_ENABLE_ERROR =
  "Desktop notifications could not be enabled. Check your operating system notification permissions and try again.";
const DESKTOP_NOTIFICATIONS_PERMISSION_DENIED =
  "Desktop notifications were not enabled because permission was denied by the operating system.";

type SettingsTab =
  | "general"
  | "behavior"
  | "notifications"
  | "integrations"
  | "shortcuts"
  | "project"
  | "advanced";

type SettingsTabMeta = {
  id: SettingsTab;
  label: string;
  description: string;
};

const SETTINGS_TABS: SettingsTabMeta[] = [
  {
    id: "general",
    label: "General",
    description: "Model, reasoning, mode, approval, and speed defaults.",
  },
  {
    id: "behavior",
    label: "Behavior",
    description: "How Codex responds, streams, and uses sub-agents.",
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Desktop alerts and completion sounds.",
  },
  {
    id: "integrations",
    label: "Integrations",
    description: "Apps shown in the Open In menu.",
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    description: "Keyboard bindings for every command.",
  },
  {
    id: "project",
    label: "Projects",
    description: "Per-project scripts and manual actions.",
  },
  {
    id: "advanced",
    label: "Advanced",
    description: "Codex binary path and app updates.",
  },
];

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

export function SettingsView({ open, onClose }: Props) {
  const settings = useWorkspaceStore(selectSettings);
  const projects = useWorkspaceStore(selectProjects);
  const selectedProjectId = useWorkspaceStore((state) => state.selectedProjectId);
  const selectedEnvironmentId = useWorkspaceStore(
    (state) => state.selectedEnvironmentId,
  );
  const settingsCapabilityEnvironmentId = useMemo(
    () =>
      resolveSettingsCapabilityEnvironmentId(
        projects,
        selectedProjectId,
        selectedEnvironmentId,
      ),
    [projects, selectedEnvironmentId, selectedProjectId],
  );
  const capabilities = useConversationStore(
    selectConversationCapabilities(settingsCapabilityEnvironmentId),
  );
  const tryLoadEnvironmentCapabilities = useConversationStore(
    (state) => state.tryLoadEnvironmentCapabilities,
  );
  const updateGlobalSettings = useWorkspaceStore((state) => state.updateGlobalSettings);
  const updateProjectSettings = useWorkspaceStore((state) => state.updateProjectSettings);
  const [actionError, setActionError] = useState<string | null>(null);
  const [desktopNotificationsNotice, setDesktopNotificationsNotice] = useState<
    string | null
  >(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [savingGlobalSettings, setSavingGlobalSettings] = useState(false);
  const [desktopNotificationsBusy, setDesktopNotificationsBusy] = useState(false);
  const savingGlobalSettingsRef = useRef(false);
  const pendingGlobalSettingsPatchRef = useRef<GlobalSettingsPatch | null>(null);
  const desktopNotificationsBusyRef = useRef(false);
  const modelOptions = useMemo(
    () =>
      settings
        ? settingsModelOptions(capabilities?.models ?? [], settings.defaultModel)
        : [],
    [capabilities?.models, settings],
  );

  useEffect(() => {
    if (!open) return;

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

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !settingsCapabilityEnvironmentId) {
      return;
    }
    void tryLoadEnvironmentCapabilities(settingsCapabilityEnvironmentId);
  }, [open, settingsCapabilityEnvironmentId, tryLoadEnvironmentCapabilities]);

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

  async function flushGlobalSettingsChanges(initialPatch: GlobalSettingsPatch) {
    let nextPatch: GlobalSettingsPatch | null = initialPatch;
    savingGlobalSettingsRef.current = true;
    setSavingGlobalSettings(true);
    try {
      while (nextPatch) {
        pendingGlobalSettingsPatchRef.current = null;
        await applyGlobalSettingsChange(nextPatch);
        nextPatch = pendingGlobalSettingsPatchRef.current;
      }
    } finally {
      savingGlobalSettingsRef.current = false;
      setSavingGlobalSettings(false);
    }
  }

  async function handleGlobalChange(patch: GlobalSettingsPatch) {
    if (savingGlobalSettingsRef.current) {
      pendingGlobalSettingsPatchRef.current = {
        ...pendingGlobalSettingsPatchRef.current,
        ...patch,
      };
      return;
    }

    await flushGlobalSettingsChanges(patch);
  }

  async function handleDesktopNotificationsChange(nextValue: boolean) {
    if (desktopNotificationsBusyRef.current || savingGlobalSettingsRef.current) {
      return;
    }

    desktopNotificationsBusyRef.current = true;
    savingGlobalSettingsRef.current = true;
    pendingGlobalSettingsPatchRef.current = null;
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
    patch: ProjectSettingsPatch,
  ) {
    setActionError(null);
    const result = await updateProjectSettings(projectId, patch);
    if (!result.ok) {
      const message = result.errorMessage ?? "Failed to save project settings";
      setActionError(message);
      throw new Error(message);
    }
    if (result.warningMessage) {
      setActionError(result.warningMessage);
    }
  }

  if (!open) {
    return null;
  }

  const activeTabMeta =
    SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0];

  function renderActiveTab() {
    if (activeTab === "project") {
      return (
        <ProjectSettingsTab
          projects={projects}
          selectedProjectId={selectedProjectId}
          shortcutSettings={settings?.shortcuts ?? {}}
          onSave={handleProjectSave}
        />
      );
    }

    if (!settings) {
      return <p className="settings-empty">Loading…</p>;
    }

    switch (activeTab) {
      case "general":
        return (
          <GeneralSettingsTab
            disabled={savingGlobalSettings}
            menuZIndex={SETTINGS_PICKER_Z_INDEX}
            modelOptions={modelOptions}
            settings={settings}
            onChange={handleGlobalChange}
          />
        );
      case "behavior":
        return (
          <BehaviorSettingsTab
            disabled={savingGlobalSettings}
            settings={settings}
            onChange={handleGlobalChange}
          />
        );
      case "notifications":
        return (
          <NotificationsSettingsTab
            settings={settings}
            disabled={savingGlobalSettings}
            desktopNotificationsBusy={desktopNotificationsBusy}
            desktopNotificationsNotice={desktopNotificationsNotice}
            menuZIndex={SETTINGS_PICKER_Z_INDEX}
            onChange={handleGlobalChange}
            onDesktopNotificationsChange={handleDesktopNotificationsChange}
          />
        );
      case "integrations":
        return (
          <OpenInSettingsTab
            targets={settings.openTargets}
            defaultTargetId={settings.defaultOpenTargetId}
          />
        );
      case "shortcuts":
        return (
          <ShortcutsSettingsTab
            shortcuts={settings.shortcuts}
            disabled={savingGlobalSettings}
            onChange={(shortcuts) => handleGlobalChange({ shortcuts })}
          />
        );
      case "advanced":
        return (
          <AdvancedSettingsTab
            disabled={savingGlobalSettings}
            settings={settings}
            onChange={handleGlobalChange}
          />
        );
    }
  }

  return (
    <section
      className="settings-view"
      role="region"
      aria-labelledby="settings-view-title"
    >
      <header className="settings-view__header">
        <button
          type="button"
          className="settings-view__back"
          onClick={onClose}
          aria-label="Back to workspace"
          title="Back"
        >
          <ArrowLeftIcon size={16} />
        </button>
        <h1 id="settings-view-title" className="settings-view__title">
          Settings
        </h1>
      </header>

      <div className="settings-view__layout">
        <nav className="settings-view__nav" aria-label="Settings sections">
          {SETTINGS_TABS.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                className={`settings-view__nav-item ${
                  isActive ? "settings-view__nav-item--active" : ""
                }`}
                aria-current={isActive ? "page" : undefined}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>

        <div className="settings-view__body">
          <div className="settings-view__body-inner">
            <div className="settings-view__body-header">
              <h2 className="settings-view__body-title">{activeTabMeta.label}</h2>
              <p className="settings-view__body-description">
                {activeTabMeta.description}
              </p>
            </div>

            {actionError ? (
              <p className="settings-notice">{actionError}</p>
            ) : null}

            {renderActiveTab()}
          </div>
        </div>
      </div>
    </section>
  );
}

function resolveSettingsCapabilityEnvironmentId(
  projects: ProjectRecord[],
  selectedProjectId: string | null,
  selectedEnvironmentId: string | null,
): string | null {
  if (selectedEnvironmentId) {
    return selectedEnvironmentId;
  }

  const selectedProject = selectedProjectId
    ? (projects.find((project) => project.id === selectedProjectId) ?? null)
    : null;
  const orderedProjects = selectedProject
    ? [
        selectedProject,
        ...projects.filter((project) => project.id !== selectedProject.id),
      ]
    : projects;

  for (const project of orderedProjects) {
    const environmentId = findPrimaryEnvironment(project)?.id ?? null;
    if (environmentId) {
      return environmentId;
    }
  }

  return null;
}
