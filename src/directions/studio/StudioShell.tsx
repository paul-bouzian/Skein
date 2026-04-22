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
  selectGitReviewScope,
  selectGitReviewSelectedFile,
  useGitReviewStore,
} from "../../stores/git-review-store";
import {
  selectEffectiveNonChatEnvironment,
  selectSelectedProject,
  selectSettings,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { ProjectActionCreateDialog } from "./ProjectActionCreateDialog";
import { useVoiceSessionStore } from "../../stores/voice-session-store";
import {
  selectSidePanelWidth,
  useSidePanelStore,
} from "../../stores/side-panel-store";
import { SettingsView } from "./SettingsView";
import { TreeSidebar } from "./TreeSidebar";
import { StudioMain } from "./StudioMain";
import { InspectorPanel } from "./InspectorPanel";
import { BrowserPanel } from "./BrowserPanel";
import { GitDiffPanel } from "./GitDiffPanel";
import { SidePanelResizer } from "./SidePanelResizer";
import { AppUpdateNotice } from "./AppUpdateNotice";
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

type RightPanel = "none" | "inspector" | "browser";

export function StudioShell() {
  const [projectsSidebarOpen, setProjectsSidebarOpen] = useState(true);
  const [rightPanel, setRightPanel] = useState<RightPanel>("none");
  const [sidePanelDragging, setSidePanelDragging] = useState(false);
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
  const scope = useGitReviewStore(
    selectGitReviewScope(reviewEnvironment?.id ?? null),
  );
  const selectedFileKey = useGitReviewStore(
    selectGitReviewSelectedFile(reviewEnvironment?.id ?? null, scope),
  );
  const actionCreateProject =
    workspaceSnapshot?.projects.find((project) => project.id === actionCreateProjectId) ?? null;
  const diffPanelOpen = Boolean(selectedFileKey);
  const actionCreateDialogOpen = !settingsOpen && actionCreateProject != null;
  const shortcutsBlocked = settingsOpen || actionCreateDialogOpen;
  const effectiveRightPanel: RightPanel =
    rightPanel === "inspector" && !reviewEnvironment ? "none" : rightPanel;
  const inspectorOpen = effectiveRightPanel === "inspector";
  const browserOpen = effectiveRightPanel === "browser";

  useEffect(() => {
    if (rightPanel === "inspector" && !reviewEnvironment) {
      setRightPanel("none");
    }
  }, [reviewEnvironment, rightPanel]);

  const openSettingsDialog = useCallback(() => {
    setActionCreateProjectId(null);
    setSettingsOpen(true);
  }, []);

  const toggleInspector = useCallback(() => {
    if (!reviewEnvironment) {
      return;
    }
    setRightPanel((current) =>
      current === "inspector" ? "none" : "inspector",
    );
  }, [reviewEnvironment]);
  const toggleBrowser = useCallback(() => {
    setRightPanel((current) => (current === "browser" ? "none" : "browser"));
  }, []);

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
      "--tx-side-panel-width",
      `${sidePanelWidth}px`,
    );
  }, [sidePanelWidth]);

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

  const rightPanelOpen = effectiveRightPanel !== "none";

  const shellClassName = [
    "studio-shell",
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
      {diffPanelOpen && <GitDiffPanel />}
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
        <InspectorPanel collapsed={!inspectorOpen} />
        <BrowserPanel collapsed={!browserOpen} />
      </div>
      <ProjectActionCreateDialog
        open={actionCreateDialogOpen}
        project={actionCreateProject}
        shortcutSettings={settings?.shortcuts ?? {}}
        onClose={() => setActionCreateProjectId(null)}
      />
      <div className="studio-notice-stack">
        <FirstPromptRenameFailureNotice />
        <AppUpdateNotice />
      </div>
      <SettingsView
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <StudioStatusBar />
    </div>
  );
}
