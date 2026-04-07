import { useEffect, useRef } from "react";

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

  const slot = useTerminalStore(selectTerminalSlot(environmentId));
  const { tabs, activeTabId } = slot;

  // Auto-open one tab whenever the panel becomes visible with zero tabs in
  // the active env (initial mount with persisted visible=true once the
  // workspace snapshot resolves the env, or reopening after closing the last
  // tab). The in-flight ref guards against re-entry while the spawn is
  // pending.
  const bootstrapInFlight = useRef(false);
  useEffect(() => {
    if (!visible || !environmentId || tabs.length > 0) return;
    if (bootstrapInFlight.current) return;
    bootstrapInFlight.current = true;
    openTab(environmentId)
      .catch((error) => console.error("Failed to open terminal:", error))
      .finally(() => {
        bootstrapInFlight.current = false;
      });
  }, [visible, environmentId, tabs.length, openTab]);

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

  if (!environmentId) {
    return (
      <div className="terminal-panel terminal-panel--empty">
        <p className="terminal-panel__hint">
          Select a worktree to open a terminal.
        </p>
      </div>
    );
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
                  onClick={() => activateTab(environmentId, tab.id)}
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  className="terminal-tab__close"
                  aria-label="Close terminal"
                  onClick={() => void closeTab(environmentId, tab.id)}
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
            title={atCap ? `Maximum ${MAX_TABS} terminals` : "New terminal"}
            disabled={atCap}
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
      <div className="terminal-panel__body">
        {tabs.map((tab) => (
          <TerminalView
            key={tab.id}
            ptyId={tab.ptyId}
            active={tab.id === activeTabId}
          />
        ))}
      </div>
    </div>
  );
}
