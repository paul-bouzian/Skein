import { useEffect, useState } from "react";
import * as bridge from "../../lib/bridge";
import {
  THEME_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEYS,
  readLocalStorageWithMigration,
} from "../../lib/app-identity";
import {
  selectGitReviewScope,
  selectGitReviewSelectedFile,
  useGitReviewStore,
} from "../../stores/git-review-store";
import {
  selectSelectedEnvironment,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { useVoiceSessionStore } from "../../stores/voice-session-store";
import { SettingsDialog } from "./SettingsDialog";
import { TreeSidebar } from "./TreeSidebar";
import { StudioMain } from "./StudioMain";
import { InspectorPanel } from "./InspectorPanel";
import { GitDiffPanel } from "./GitDiffPanel";
import { AppUpdateNotice } from "./AppUpdateNotice";
import { FirstPromptRenameFailureNotice } from "./FirstPromptRenameFailureNotice";
import { StudioStatusBar } from "./StudioStatusBar";
import { useStudioShortcuts } from "./useStudioShortcuts";
import "./StudioShell.css";

export type Theme = "dark" | "light";

function readTheme(): Theme {
  try {
    const v = readLocalStorageWithMigration(
      THEME_STORAGE_KEY,
      LEGACY_THEME_STORAGE_KEYS,
    );
    if (v === "light") return "light";
  } catch {
    /* ignore */
  }
  return "dark";
}

export function StudioShell() {
  const [projectsSidebarOpen, setProjectsSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [composerFocusNonce, setComposerFocusNonce] = useState(0);
  const [approveOrSubmitNonce, setApproveOrSubmitNonce] = useState(0);
  const workspaceSnapshot = useWorkspaceStore((state) => state.snapshot);
  const selectedEnvironment = useWorkspaceStore(selectSelectedEnvironment);
  const reconcileVoiceSessionSnapshot = useVoiceSessionStore(
    (state) => state.reconcileWorkspaceSnapshot,
  );
  const scope = useGitReviewStore(
    selectGitReviewScope(selectedEnvironment?.id ?? null),
  );
  const selectedFileKey = useGitReviewStore(
    selectGitReviewSelectedFile(selectedEnvironment?.id ?? null, scope),
  );
  const diffPanelOpen = Boolean(selectedFileKey);

  useStudioShortcuts({
    settingsOpen,
    onOpenSettings: () => setSettingsOpen(true),
    onRequestApproveOrSubmit: () =>
      setApproveOrSubmitNonce((current) => current + 1),
    onRequestComposerFocus: () => setComposerFocusNonce((current) => current + 1),
    onToggleProjectsSidebar: () =>
      setProjectsSidebarOpen((current) => !current),
    onToggleReviewPanel: () => setInspectorOpen((current) => !current),
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    void reconcileVoiceSessionSnapshot(workspaceSnapshot);
  }, [reconcileVoiceSessionSnapshot, workspaceSnapshot]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void bridge.listenToMenuOpenSettings(() => {
      setSettingsOpen(true);
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
  }, []);

  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  return (
    <div className="studio-shell">
      <TreeSidebar
        theme={theme}
        collapsed={!projectsSidebarOpen}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleTheme={toggleTheme}
      />
      <StudioMain
        theme={theme}
        projectsSidebarOpen={projectsSidebarOpen}
        inspectorOpen={inspectorOpen}
        composerFocusKey={composerFocusNonce}
        approveOrSubmitKey={approveOrSubmitNonce}
        onToggleProjectsSidebar={() =>
          setProjectsSidebarOpen((current) => !current)
        }
        onToggleInspector={() => setInspectorOpen((v) => !v)}
      />
      {diffPanelOpen && <GitDiffPanel />}
      <InspectorPanel collapsed={!inspectorOpen} />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <div className="studio-notice-stack">
        <FirstPromptRenameFailureNotice />
        <AppUpdateNotice />
      </div>
      <StudioStatusBar />
    </div>
  );
}
