import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

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

const bootstrapOpenPromises = new Map<string, Promise<string | null>>();

function ensureBootstrapTab(
  environmentId: string,
  openTab: (environmentId: string) => Promise<string | null>,
) {
  const existing = bootstrapOpenPromises.get(environmentId);
  if (existing) return existing;

  const promise = openTab(environmentId).finally(() => {
    if (bootstrapOpenPromises.get(environmentId) === promise) {
      bootstrapOpenPromises.delete(environmentId);
    }
  });
  bootstrapOpenPromises.set(environmentId, promise);
  return promise;
}

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
  const selectedEnvironmentId = environmentId ?? "";
  const activeTab =
    tabs.find((tab) => tab.id === activeTabId) ?? tabs[tabs.length - 1] ?? null;

  // Auto-open one tab whenever the panel becomes visible with zero tabs in
  // the active env (initial mount with persisted visible=true once the
  // workspace snapshot resolves the env, or reopening an explicitly hidden
  // panel). bootstrapInFlight is state (not a ref) on purpose: we need the
  // effect to re-run after the promise settles so we can bootstrap the NEXT
  // env if the user switched worktrees while the first spawn was pending.
  // bootstrapFailedEnvId short-circuits the effect after a spawn failure so
  // we don't hammer the backend in a tight retry loop; it resets when the
  // panel is hidden or the user switches to a different env. Explicitly
  // closing the last tab in an env dismisses auto-bootstrap for that env
  // until the panel is hidden again or the user opens a new tab manually.
  const [bootstrapInFlight, setBootstrapInFlight] = useState(false);
  const [bootstrapFailedEnvId, setBootstrapFailedEnvId] = useState<
    string | null
  >(null);
  const [dismissedBootstrapEnvIds, setDismissedBootstrapEnvIds] = useState<
    string[]
  >([]);
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (bootstrapFailedEnvId && environmentId !== bootstrapFailedEnvId) {
      setBootstrapFailedEnvId(null);
    }
  }, [bootstrapFailedEnvId, environmentId]);

  useEffect(() => {
    if (!visible) {
      setBootstrapFailedEnvId(null);
      setDismissedBootstrapEnvIds([]);
      return;
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !environmentId || tabs.length > 0) return;
    if (bootstrapInFlight) return;
    if (bootstrapFailedEnvId === environmentId) return;
    if (dismissedBootstrapEnvIds.includes(environmentId)) return;
    setBootstrapInFlight(true);
    ensureBootstrapTab(environmentId, openTab)
      .then(() => {
        setBootstrapFailedEnvId(null);
        setDismissedBootstrapEnvIds((current) =>
          current.filter((id) => id !== environmentId),
        );
      })
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
    dismissedBootstrapEnvIds,
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
      })
      .catch((error) => {
        console.error("Failed to subscribe to terminal exit events:", error);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [markExited]);

  const atCap = tabs.length >= MAX_TABS;

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    activateTab(selectedEnvironmentId, nextTab.id);
    tabButtonRefs.current[nextTab.id]?.focus();
  }

  function handleOpenTab() {
    if (!environmentId) return;
    openTab(environmentId).catch((error) => {
      console.error("Failed to open terminal:", error);
    });
  }

  function handleCloseTab(tabId: string) {
    if (!environmentId) return;
    if (tabs.length === 1) {
      setDismissedBootstrapEnvIds((current) =>
        current.includes(environmentId) ? current : [...current, environmentId],
      );
    }
    void closeTab(environmentId, tabId);
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__header">
        <div
          className="terminal-panel__tabs"
          role="tablist"
          aria-label="Terminal tabs"
        >
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTabId;
            const className = [
              "terminal-tab",
              isActive ? "terminal-tab--active" : "",
              tab.exited ? "terminal-tab--exited" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={tab.id} className={className}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  className="terminal-tab__title"
                  title={tab.cwd || tab.title}
                  ref={(element) => {
                    tabButtonRefs.current[tab.id] = element;
                  }}
                  onClick={() => activateTab(selectedEnvironmentId, tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  className="terminal-tab__close"
                  aria-label="Close terminal"
                  onClick={() => handleCloseTab(tab.id)}
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
            aria-label={
              !environmentId
                ? "Select a worktree first"
                : atCap
                  ? `Maximum ${MAX_TABS} terminals`
                  : "New terminal"
            }
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
            aria-label="Hide terminal"
            title="Hide terminal"
            onClick={() => setVisible(false)}
          >
            <CloseIcon size={13} />
          </button>
        </div>
      </div>
      <div
        className={`terminal-panel__body ${
          activeTab ? "" : "terminal-panel__body--empty"
        }`}
      >
        {activeTab && (
          <TerminalView
            key={`${selectedEnvironmentId}:${activeTab.id}`}
            ptyId={activeTab.ptyId}
            active
            exited={activeTab.exited}
          />
        )}
        {!environmentId && (
          <div className="terminal-panel__empty-state">
            <p className="terminal-panel__hint">
              Select a worktree to open a terminal.
            </p>
          </div>
        )}
        {environmentId && !activeTab && (
          <div className="terminal-panel__empty-state">
            <p className="terminal-panel__hint">
              No terminals are open in this worktree.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
