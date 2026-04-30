import { useCallback, useEffect, useState } from "react";
import * as bridge from "../../lib/bridge";
import {
  THEME_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEYS,
} from "../../lib/app-identity";
import {
  persistUiPreference,
  readUiPreferenceWithMigration,
} from "../../lib/ui-prefs";
import { menuShell } from "../../lib/shell";
import {
  selectEffectiveNonChatEnvironment,
  selectSelectedProject,
  selectSettings,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { ProjectActionCreateDialog } from "./ProjectActionCreateDialog";
import { useVoiceSessionStore } from "../../stores/voice-session-store";
import {
  selectSidebarPanelWidth,
  selectSidePanelWidth,
  useSidePanelStore,
} from "../../stores/side-panel-store";
import { SettingsView } from "./SettingsView";
import { TreeSidebar } from "./TreeSidebar";
import { StudioMain } from "./StudioMain";
import {
  WorkspaceRightPanel,
  type WorkspaceRightPanelTab,
} from "./WorkspaceRightPanel";
import { SidePanelResizer } from "./SidePanelResizer";
import { FirstPromptRenameFailureNotice } from "./FirstPromptRenameFailureNotice";
import { StudioStatusBar } from "./StudioStatusBar";
import { useLocalhostAutoDetect } from "./useLocalhostAutoDetect";
import { useStudioShortcuts } from "./useStudioShortcuts";
import "./StudioShell.css";
import "./SidePanelResizer.css";

export type Theme = "dark" | "light";

function readTheme(): Theme {
  try {
    const v = readUiPreferenceWithMigration(
      THEME_STORAGE_KEY,
      LEGACY_THEME_STORAGE_KEYS,
    );
    if (v === "light") return "light";
  } catch {
    /* ignore */
  }
  return "dark";
}

type RightPanel = "none" | "workspace";

export function StudioShell() {
  const [projectsSidebarOpen, setProjectsSidebarOpen] = useState(true);
  const [rightPanel, setRightPanel] = useState<RightPanel>("none");
  const [rightPanelTab, setRightPanelTab] =
    useState<WorkspaceRightPanelTab>("diff");
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const [sidePanelDragging, setSidePanelDragging] = useState(false);
  const sidebarWidth = useSidePanelStore(selectSidebarPanelWidth);
  const setSidebarWidth = useSidePanelStore((state) => state.setSidebarWidth);
  const sidePanelWidth = useSidePanelStore(selectSidePanelWidth);
  const setSidePanelWidth = useSidePanelStore((state) => state.setWidth);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionCreateProjectId, setActionCreateProjectId] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [composerFocusNonce, setComposerFocusNonce] = useState(0);
  const [approveOrSubmitNonce, setApproveOrSubmitNonce] = useState(0);
  const workspaceSnapshot = useWorkspaceStore((state) => state.snapshot);
  const settings = useWorkspaceStore(selectSettings);
  const selectedProject = useWorkspaceStore(selectSelectedProject);
  const reviewEnvironment = useWorkspaceStore(selectEffectiveNonChatEnvironment);
  const reconcileVoiceSessionSnapshot = useVoiceSessionStore(
    (state) => state.reconcileWorkspaceSnapshot,
  );
  const actionCreateProject =
    workspaceSnapshot?.projects.find((project) => project.id === actionCreateProjectId) ?? null;
  const actionCreateDialogOpen = !settingsOpen && actionCreateProject != null;
  const shortcutsBlocked = settingsOpen || actionCreateDialogOpen;
  const effectiveRightPanel: RightPanel =
    rightPanel === "workspace" && rightPanelTab !== "browser" && !reviewEnvironment
      ? "none"
      : rightPanel;
  const rightPanelOpen = effectiveRightPanel !== "none";
  const inspectorOpen = rightPanelOpen && rightPanelTab !== "browser";
  const browserOpen = rightPanelOpen && rightPanelTab === "browser";

  useEffect(() => {
    if (rightPanel === "workspace" && rightPanelTab !== "browser" && !reviewEnvironment) {
      setRightPanel("none");
    }
  }, [reviewEnvironment, rightPanel, rightPanelTab]);

  const openSettingsDialog = useCallback(() => {
    setActionCreateProjectId(null);
    setSettingsOpen(true);
  }, []);

  const toggleInspector = useCallback(() => {
    if (!reviewEnvironment) {
      return;
    }
    setRightPanel((current) => {
      if (current === "workspace" && rightPanelTab !== "browser") return "none";
      setRightPanelTab("diff");
      return "workspace";
    });
  }, [reviewEnvironment, rightPanelTab]);
  const toggleBrowser = useCallback(() => {
    setRightPanel((current) => {
      if (current === "workspace" && rightPanelTab === "browser") return "none";
      setRightPanelTab("browser");
      return "workspace";
    });
  }, [rightPanelTab]);

  useStudioShortcuts({
    shortcutsBlocked,
    onOpenSettings: openSettingsDialog,
    onRequestApproveOrSubmit: () =>
      setApproveOrSubmitNonce((current) => current + 1),
    onRequestComposerFocus: () => setComposerFocusNonce((current) => current + 1),
    onToggleProjectsSidebar: () =>
      setProjectsSidebarOpen((current) => !current),
    onToggleReviewPanel: toggleInspector,
  });

  useLocalhostAutoDetect();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    void persistUiPreference(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--tx-sidebar-width",
      `${sidebarWidth}px`,
    );
    document.documentElement.style.setProperty(
      "--tx-side-panel-width",
      `${sidePanelWidth}px`,
    );
  }, [sidebarWidth, sidePanelWidth]);

  useEffect(() => {
    void menuShell
      .setOpenSettingsShortcut(settings?.shortcuts?.openSettings ?? null)
      .catch(() => undefined);
  }, [settings?.shortcuts?.openSettings]);

  useEffect(() => {
    void reconcileVoiceSessionSnapshot(workspaceSnapshot);
  }, [reconcileVoiceSessionSnapshot, workspaceSnapshot]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void bridge.listenToMenuOpenSettings(() => {
      openSettingsDialog();
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openSettingsDialog]);

  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  const shellClassName = [
    "studio-shell",
    sidebarDragging ? "studio-shell--resizing-sidebar" : null,
    sidePanelDragging ? "studio-shell--resizing-side-panel" : null,
    settingsOpen ? "studio-shell--settings-open" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClassName}>
      <TreeSidebar
        theme={theme}
        collapsed={!projectsSidebarOpen}
        onOpenSettings={openSettingsDialog}
        onToggleTheme={toggleTheme}
      />
      {projectsSidebarOpen && (
        <SidePanelResizer
          side="left"
          width={sidebarWidth}
          onResize={setSidebarWidth}
          onDraggingChange={setSidebarDragging}
        />
      )}
      <StudioMain
        theme={theme}
        projectsSidebarOpen={projectsSidebarOpen}
        inspectorOpen={inspectorOpen}
        browserOpen={browserOpen}
        composerFocusKey={composerFocusNonce}
        approveOrSubmitKey={approveOrSubmitNonce}
        onOpenActionCreateDialog={() =>
          setActionCreateProjectId(selectedProject?.id ?? null)
        }
        onToggleProjectsSidebar={() =>
          setProjectsSidebarOpen((current) => !current)
        }
        onToggleInspector={toggleInspector}
        onToggleBrowser={toggleBrowser}
      />
      {rightPanelOpen && (
        <SidePanelResizer
          width={sidePanelWidth}
          onResize={setSidePanelWidth}
          onDraggingChange={setSidePanelDragging}
        />
      )}
      <div
        className="studio-shell__right-panel"
        data-right-panel={effectiveRightPanel}
      >
        <WorkspaceRightPanel
          activeTab={rightPanelTab}
          collapsed={!rightPanelOpen}
          onClose={() => setRightPanel("none")}
          onTabChange={(tab) => {
            setRightPanelTab(tab);
            setRightPanel("workspace");
          }}
        />
      </div>
      <ProjectActionCreateDialog
        open={actionCreateDialogOpen}
        project={actionCreateProject}
        shortcutSettings={settings?.shortcuts ?? {}}
        onClose={() => setActionCreateProjectId(null)}
      />
      <div className="studio-notice-stack">
        <FirstPromptRenameFailureNotice />
      </div>
      <SettingsView
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <StudioStatusBar />
    </div>
  );
}
