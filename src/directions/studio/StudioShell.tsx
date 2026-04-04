import { useEffect, useState } from "react";
import {
  selectGitReviewScope,
  selectGitReviewSelectedFile,
  useGitReviewStore,
} from "../../stores/git-review-store";
import {
  selectSelectedEnvironment,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { SettingsDialog } from "./SettingsDialog";
import { TreeSidebar } from "./TreeSidebar";
import { StudioMain } from "./StudioMain";
import { InspectorPanel } from "./InspectorPanel";
import { GitDiffPanel } from "./GitDiffPanel";
import { AppUpdateNotice } from "./AppUpdateNotice";
import { StudioStatusBar } from "./StudioStatusBar";
import "./StudioShell.css";

export type Theme = "dark" | "light";

function readTheme(): Theme {
  try {
    const v = localStorage.getItem("threadex-theme");
    if (v === "light") return "light";
  } catch {
    /* ignore */
  }
  return "dark";
}

export function StudioShell() {
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const selectedEnvironment = useWorkspaceStore(selectSelectedEnvironment);
  const scope = useGitReviewStore(
    selectGitReviewScope(selectedEnvironment?.id ?? null),
  );
  const selectedFileKey = useGitReviewStore(
    selectGitReviewSelectedFile(selectedEnvironment?.id ?? null, scope),
  );
  const diffPanelOpen = Boolean(selectedFileKey);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("threadex-theme", theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  return (
    <div
      className={`studio-shell ${diffPanelOpen ? "studio-shell--with-diff" : ""}`}
    >
      <TreeSidebar
        theme={theme}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleTheme={toggleTheme}
      />
      <StudioMain
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
      />
      {diffPanelOpen && <GitDiffPanel />}
      {inspectorOpen && <InspectorPanel />}
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <AppUpdateNotice />
      <StudioStatusBar />
    </div>
  );
}
