import { useCallback, useEffect, useRef } from "react";

import { normalizeBrowserUrl } from "../../lib/browser-preview";
import { openExternalUrl } from "../../lib/shell";
import { GlobeIcon } from "../../shared/Icons";
import {
  BROWSER_HOME_URL,
  selectActiveTab,
  selectBrowserSlot,
  selectCanGoBack,
  selectCanGoForward,
  selectCurrentUrl,
  useBrowserStore,
  type BrowserTab,
} from "../../stores/browser-store";
import {
  selectEffectiveEnvironment,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { BrowserFrame } from "./BrowserFrame";
import { BrowserTabBar } from "./BrowserTabBar";
import { BrowserUrlBar } from "./BrowserUrlBar";
import "./BrowserPanel.css";

type Props = {
  collapsed?: boolean;
};

function isPristineBlankTab(tab: BrowserTab | null): boolean {
  return (
    tab !== null &&
    tab.history.length === 1 &&
    tab.history[0] === BROWSER_HOME_URL
  );
}

export function BrowserPanel({ collapsed = false }: Props) {
  const environment = useWorkspaceStore(selectEffectiveEnvironment);
  const environmentId = environment?.id ?? null;
  const slot = useBrowserStore(selectBrowserSlot(environmentId));
  const activeTab = selectActiveTab(slot);
  const canGoBack = selectCanGoBack(slot);
  const canGoForward = selectCanGoForward(slot);
  const currentUrl = selectCurrentUrl(slot) ?? "";
  const seededEnvIdsRef = useRef<Set<string>>(new Set());

  const openTab = useBrowserStore((state) => state.openTab);
  const closeTab = useBrowserStore((state) => state.closeTab);
  const activateTab = useBrowserStore((state) => state.activateTab);
  const navigate = useBrowserStore((state) => state.navigate);
  const back = useBrowserStore((state) => state.back);
  const forward = useBrowserStore((state) => state.forward);
  const reload = useBrowserStore((state) => state.reload);
  const markLoaded = useBrowserStore((state) => state.markLoaded);

  // Seed the first tab only the first time the panel is revealed for an
  // env. Once the user has used the panel (even if they close every tab)
  // we respect the empty state instead of re-spawning a new tab behind
  // their back. Switching to another env seeds that env once, too.
  useEffect(() => {
    if (collapsed || !environmentId) return;
    const seen = seededEnvIdsRef.current;
    if (slot.tabs.length > 0) {
      seen.add(environmentId);
      return;
    }
    if (seen.has(environmentId)) return;
    seen.add(environmentId);
    openTab(environmentId);
  }, [collapsed, environmentId, slot.tabs.length, openTab]);

  // Drop a detected dev-server URL into a pristine about:blank tab so the
  // user doesn't have to type it themselves.
  const detectedTopUrl = slot.detectedUrls[0]?.url ?? null;
  useEffect(() => {
    if (collapsed || !environmentId || !detectedTopUrl) return;
    if (!isPristineBlankTab(activeTab)) return;
    navigate(environmentId, detectedTopUrl);
  }, [collapsed, environmentId, detectedTopUrl, activeTab, navigate]);

  const handleNavigate = useCallback(
    (url: string) => {
      if (!environmentId) return;
      const normalized = normalizeBrowserUrl(url);
      if (!normalized) return;
      if (slot.activeTabId) {
        navigate(environmentId, normalized);
      } else {
        openTab(environmentId, normalized);
      }
    },
    [environmentId, slot.activeTabId, openTab, navigate],
  );

  const handleOpenExternal = useCallback((url: string) => {
    if (!url || url === BROWSER_HOME_URL) return;
    void openExternalUrl(url).catch((error) => {
      console.error("Failed to open URL externally:", error);
    });
  }, []);

  const urlBarUrl = currentUrl === BROWSER_HOME_URL ? "" : currentUrl;
  const showEnvSelectPrompt = !environmentId;

  return (
    <aside
      className={`browser-panel ${collapsed ? "browser-panel--collapsed" : ""}`}
      data-testid="browser-panel"
      inert={collapsed || undefined}
    >
      <div className="browser-panel__header">
        <span className="browser-panel__title">
          <GlobeIcon size={12} />
          Browser
        </span>
        <BrowserUrlBar
          currentUrl={urlBarUrl}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          loading={activeTab?.pending ?? false}
          detectedUrls={slot.detectedUrls}
          onBack={() => environmentId && back(environmentId)}
          onForward={() => environmentId && forward(environmentId)}
          onReload={() => environmentId && reload(environmentId)}
          onNavigate={handleNavigate}
          onOpenExternal={handleOpenExternal}
        />
        <BrowserTabBar
          tabs={slot.tabs}
          activeTabId={slot.activeTabId}
          onActivate={(id) => environmentId && activateTab(environmentId, id)}
          onClose={(id) => environmentId && closeTab(environmentId, id)}
          onNewTab={() => environmentId && openTab(environmentId)}
        />
      </div>
      <div className="browser-panel__body">
        {slot.tabs.map((tab) => (
          <BrowserFrame
            key={tab.id}
            tabId={tab.id}
            url={tab.history[tab.cursor] ?? BROWSER_HOME_URL}
            reloadNonce={tab.reloadNonce}
            active={tab.id === slot.activeTabId}
            onLoad={(tabId) => environmentId && markLoaded(environmentId, tabId)}
          />
        ))}
        {showEnvSelectPrompt && (
          <div className="browser-panel__empty-state">
            <p className="browser-panel__hint">
              Select an environment to start browsing.
            </p>
          </div>
        )}
        {environmentId && !activeTab && (
          <div className="browser-panel__empty-state">
            <p className="browser-panel__hint">
              Open a tab to start browsing.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
