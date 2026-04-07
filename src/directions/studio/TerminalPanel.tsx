import { useEffect, useState } from "react";

import * as bridge from "../../lib/bridge";
import { CloseIcon, PlusIcon } from "../../shared/Icons";
import {
  MAX_TABS,
  selectTerminalSlot,
  useTerminalStore,
} from "../../stores/terminal-store";
import {
  selectSelectedEnvironment,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { TerminalView } from "./TerminalView";
import "./TerminalPanel.css";

export function TerminalPanel() {
  const visible = useTerminalStore((s) => s.visible);
  const openTab = useTerminalStore((s) => s.openTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const activateTab = useTerminalStore((s) => s.activateTab);
  const markExited = useTerminalStore((s) => s.markExited);
  const setVisible = useTerminalStore((s) => s.setVisible);

  const env = useWorkspaceStore(selectSelectedEnvironment);
  const environmentId = env?.id ?? null;

  const byEnv = useTerminalStore((s) => s.byEnv);
  const slot = useTerminalStore(selectTerminalSlot(environmentId));
  const { tabs, activeTabId } = slot;
  const selectedEnvironmentId = environmentId ?? "";
  const mountedTabs = Object.entries(byEnv).flatMap(([envId, envSlot]) =>
    envSlot.tabs.map((tab) => ({
      envId,
      tab,
      active: envId === environmentId && envSlot.activeTabId === tab.id,
    })),
  );

  // Auto-open one tab whenever the panel becomes visible with zero tabs in
  // the active env (initial mount with persisted visible=true once the
  // workspace snapshot resolves the env, or reopening after closing the last
  // tab). bootstrapInFlight is state (not a ref) on purpose: we need the
  // effect to re-run after the promise settles so we can bootstrap the NEXT
  // env if the user switched worktrees while the first spawn was pending.
  // bootstrapFailedEnvId short-circuits the effect after a spawn failure so
  // we don't hammer the backend in a tight retry loop; it resets when the
  // panel is hidden or the user switches to a different env.
  const [bootstrapInFlight, setBootstrapInFlight] = useState(false);
  const [bootstrapFailedEnvId, setBootstrapFailedEnvId] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (!visible) {
      setBootstrapFailedEnvId(null);
      return;
    }
    if (!environmentId || tabs.length > 0) return;
    if (bootstrapInFlight) return;
    if (bootstrapFailedEnvId === environmentId) return;
    setBootstrapInFlight(true);
    openTab(environmentId)
      .then(() => setBootstrapFailedEnvId(null))
      .catch((error) => {
        console.error("Failed to open terminal:", error);
        setBootstrapFailedEnvId(environmentId);
      })
      .finally(() => setBootstrapInFlight(false));
  }, [
    visible,
    environmentId,
    tabs.length,
    openTab,
    bootstrapInFlight,
    bootstrapFailedEnvId,
  ]);

  // Subscribe once to terminal-exit events at the panel level.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    bridge
      .listenToTerminalExit((payload) => markExited(payload.ptyId))
      .then((un) => {
        if (cancelled) {
          un();
        } else {
          unlisten = un;
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [markExited]);

  const atCap = tabs.length >= MAX_TABS;

  function handleOpenTab() {
    if (!environmentId) return;
    openTab(environmentId).catch((error) => {
      console.error("Failed to open terminal:", error);
    });
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__header">
        <div className="terminal-panel__tabs" role="tablist">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const className = [
              "terminal-tab",
              isActive ? "terminal-tab--active" : "",
              tab.exited ? "terminal-tab--exited" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                className={className}
              >
                <button
                  type="button"
                  className="terminal-tab__title"
                  title={tab.cwd || tab.title}
                  onClick={() => activateTab(selectedEnvironmentId, tab.id)}
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  className="terminal-tab__close"
                  aria-label="Close terminal"
                  onClick={() => void closeTab(selectedEnvironmentId, tab.id)}
                >
                  <CloseIcon size={11} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="terminal-panel__actions">
          <button
            type="button"
            className="terminal-panel__action"
            title={
              !environmentId
                ? "Select a worktree first"
                : atCap
                  ? `Maximum ${MAX_TABS} terminals`
                  : "New terminal"
            }
            disabled={!environmentId || atCap}
            onClick={handleOpenTab}
          >
            <PlusIcon size={13} />
          </button>
          <button
            type="button"
            className="terminal-panel__action"
            title="Hide terminal"
            onClick={() => setVisible(false)}
          >
            <CloseIcon size={13} />
          </button>
        </div>
      </div>
      <div
        className={`terminal-panel__body ${
          environmentId ? "" : "terminal-panel__body--empty"
        }`}
      >
        {mountedTabs.map(({ envId, tab, active }) => (
          <TerminalView
            key={`${envId}:${tab.id}`}
            ptyId={tab.ptyId}
            active={active}
          />
        ))}
        {!environmentId && (
          <div className="terminal-panel__empty-state">
            <p className="terminal-panel__hint">
              Select a worktree to open a terminal.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
