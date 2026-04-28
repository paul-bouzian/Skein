import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { CloseIcon, PlusIcon } from "../../shared/Icons";
import {
  MAX_TABS,
  selectTerminalSlot,
  useTerminalStore,
} from "../../stores/terminal-store";
import {
  selectEffectiveNonChatEnvironment,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { TerminalView } from "./TerminalView";
import type { Theme } from "./StudioShell";
import "./TerminalPanel.css";

type Props = {
  theme: Theme;
};

export function TerminalPanel({ theme }: Props) {
  const openTab = useTerminalStore((s) => s.openTab);
  const ensureVisible = useTerminalStore((s) => s.ensureVisible);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const activateTab = useTerminalStore((s) => s.activateTab);
  const setVisible = useTerminalStore((s) => s.setVisible);

  const env = useWorkspaceStore(selectEffectiveNonChatEnvironment);
  const environmentId = env?.id ?? null;
  const slot = useTerminalStore(selectTerminalSlot(environmentId));
  const { tabs, activeTabId, visible } = slot;
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
  // panel is hidden or the user switches to a different env.
  const [bootstrapInFlight, setBootstrapInFlight] = useState(false);
  const [bootstrapFailedEnvId, setBootstrapFailedEnvId] = useState<
    string | null
  >(null);
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (bootstrapFailedEnvId && environmentId !== bootstrapFailedEnvId) {
      setBootstrapFailedEnvId(null);
    }
  }, [bootstrapFailedEnvId, environmentId]);

  useEffect(() => {
    if (!visible) {
      setBootstrapFailedEnvId(null);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !environmentId || tabs.length > 0) return;
    if (bootstrapInFlight) return;
    if (bootstrapFailedEnvId === environmentId) return;
    setBootstrapInFlight(true);
    ensureVisible(environmentId)
      .then(() => {
        setBootstrapFailedEnvId(null);
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
    ensureVisible,
    bootstrapInFlight,
    bootstrapFailedEnvId,
  ]);

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
    void closeTab(environmentId, tabId);
  }

  return (
    <div
      className="terminal-panel"
      data-terminal-panel="true"
      data-terminal-theme={theme}
    >
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
                ? "Select an environment first"
                : atCap
                  ? `Maximum ${MAX_TABS} terminals`
                  : "New terminal"
            }
            title={
              !environmentId
                ? "Select an environment first"
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
            onClick={() => {
              if (!environmentId) {
                return;
              }
              setVisible(environmentId, false);
            }}
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
            theme={theme}
          />
        )}
        {!environmentId && (
          <div className="terminal-panel__empty-state">
            <p className="terminal-panel__hint">
              Select an environment to open a terminal.
            </p>
          </div>
        )}
        {environmentId && !activeTab && (
          <div className="terminal-panel__empty-state">
            <p className="terminal-panel__hint">
              No terminals are open in this environment.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
