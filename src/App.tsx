import { useEffect } from "react";
import { useConversationStore } from "./stores/conversation-store";
import { useCodexUsageStore } from "./stores/codex-usage-store";
import { useAppUpdateStore } from "./stores/app-update-store";
import {
  teardownWorktreeScriptListener,
  useWorktreeScriptStore,
} from "./stores/worktree-script-store";
import {
  teardownWorkspaceListener,
  useWorkspaceStore,
} from "./stores/workspace-store";
import { LoadingState } from "./shared/LoadingState";
import { StudioShell } from "./directions/studio/StudioShell";
import "./App.css";

function App() {
  const initialize = useWorkspaceStore((s) => s.initialize);
  const initializeWorkspaceListener = useWorkspaceStore(
    (s) => s.initializeListener,
  );
  const loadingState = useWorkspaceStore((s) => s.loadingState);
  const error = useWorkspaceStore((s) => s.error);
  const initializeConversationListener = useConversationStore(
    (s) => s.initializeListener,
  );
  const initializeCodexUsageListener = useCodexUsageStore(
    (s) => s.initializeListener,
  );
  const initializeUpdates = useAppUpdateStore((s) => s.initialize);
  const initializeWorktreeScriptListener = useWorktreeScriptStore(
    (s) => s.initializeListener,
  );

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    void initializeWorkspaceListener();
    return () => {
      teardownWorkspaceListener();
    };
  }, [initializeWorkspaceListener]);

  useEffect(() => {
    void initializeConversationListener();
  }, [initializeConversationListener]);

  useEffect(() => {
    void initializeCodexUsageListener();
  }, [initializeCodexUsageListener]);

  useEffect(() => {
    void initializeUpdates();
  }, [initializeUpdates]);

  useEffect(() => {
    void initializeWorktreeScriptListener();
    return () => {
      teardownWorktreeScriptListener();
    };
  }, [initializeWorktreeScriptListener]);

  if (loadingState === "idle" || loadingState === "loading") {
    return (
      <div className="app-loading">
        <LoadingState />
      </div>
    );
  }

  if (loadingState === "error") {
    return (
      <div className="app-error">
        <h2>Failed to load workspace</h2>
        <p>{error}</p>
        <button className="app-error__retry" onClick={() => void initialize()}>
          Retry
        </button>
      </div>
    );
  }

  return <StudioShell />;
}

export default App;
