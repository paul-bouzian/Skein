import { useCallback, useEffect, useRef } from "react";

import * as bridge from "../../lib/bridge";
import { CloseIcon, PlusIcon } from "../../shared/Icons";
import { MAX_TABS, useTerminalStore } from "../../stores/terminal-store";
import {
  selectSelectedEnvironment,
  selectSelectedProject,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { TerminalView } from "./TerminalView";
import "./TerminalPanel.css";

export function TerminalPanel() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const openTab = useTerminalStore((s) => s.openTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const activateTab = useTerminalStore((s) => s.activateTab);
  const markExited = useTerminalStore((s) => s.markExited);
  const setVisible = useTerminalStore((s) => s.setVisible);

  const env = useWorkspaceStore(selectSelectedEnvironment);
  const project = useWorkspaceStore(selectSelectedProject);

  // Empty string => Rust backend will substitute $HOME.
  const defaultCwd = env?.path ?? project?.rootPath ?? "";

  const handleOpenTab = useCallback(() => {
    openTab(defaultCwd).catch((error) => {
      console.error("Failed to open terminal:", error);
    });
  }, [openTab, defaultCwd]);

  // Auto-open one tab the first time the panel mounts with zero tabs.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current || tabs.length > 0) return;
    bootstrapped.current = true;
    handleOpenTab();
  }, [tabs.length, handleOpenTab]);

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
                  onClick={() => activateTab(tab.id)}
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  className="terminal-tab__close"
                  aria-label="Close terminal"
                  onClick={() => void closeTab(tab.id)}
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
