import { useCallback, useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { GlobeIcon } from "../../shared/Icons";
import {
  BROWSER_HOME_URL,
  selectActiveTab,
  selectCanGoBack,
  selectCanGoForward,
  selectCurrentUrl,
  useBrowserStore,
} from "../../stores/browser-store";
import { BrowserFrame } from "./BrowserFrame";
import { BrowserTabBar } from "./BrowserTabBar";
import { BrowserUrlBar, normalizeBrowserUrl } from "./BrowserUrlBar";
import "./BrowserPanel.css";

type Props = {
  collapsed?: boolean;
};

export function BrowserPanel({ collapsed = false }: Props) {
  const tabs = useBrowserStore((state) => state.tabs);
  const activeTabId = useBrowserStore((state) => state.activeTabId);
  const detectedUrls = useBrowserStore((state) => state.detectedUrls);
  const activeTab = useBrowserStore(selectActiveTab);
  const canGoBack = useBrowserStore(selectCanGoBack);
  const canGoForward = useBrowserStore(selectCanGoForward);
  const currentUrl = useBrowserStore(selectCurrentUrl) ?? "";

  const openTab = useBrowserStore((state) => state.openTab);
  const closeTab = useBrowserStore((state) => state.closeTab);
  const activateTab = useBrowserStore((state) => state.activateTab);
  const navigate = useBrowserStore((state) => state.navigate);
  const back = useBrowserStore((state) => state.back);
  const forward = useBrowserStore((state) => state.forward);
  const reload = useBrowserStore((state) => state.reload);
  const markLoaded = useBrowserStore((state) => state.markLoaded);

  // Auto-create one empty tab the first time the panel renders visible and
  // has no tabs, so the user sees the URL bar instead of a blank void.
  useEffect(() => {
    if (collapsed) return;
    if (tabs.length === 0) {
      openTab();
    }
  }, [collapsed, tabs.length, openTab]);

  const handleNavigate = useCallback(
    (url: string) => {
      const normalized = normalizeBrowserUrl(url) ?? url;
      if (!activeTabId) {
        openTab(normalized);
        return;
      }
      navigate(normalized);
    },
    [activeTabId, openTab, navigate],
  );

  const handleNewTab = useCallback(() => {
    const id = openTab();
    if (id == null) {
      // Caller can surface a toast later; keep silent for now.
      return;
    }
  }, [openTab]);

  const handleOpenExternal = useCallback((url: string) => {
    if (!url || url === BROWSER_HOME_URL) return;
    void openUrl(url).catch((error) => {
      console.error("Failed to open URL externally:", error);
    });
  }, []);

  const urlBarUrl =
    currentUrl === BROWSER_HOME_URL ? "" : currentUrl;

  return (
    <aside
      className={`browser-panel ${collapsed ? "browser-panel--collapsed" : ""}`}
      data-testid="browser-panel"
      inert={collapsed || undefined}
    >
      <div className="browser-panel__header">
        <div className="browser-panel__title-row">
          <span className="browser-panel__title">
            <GlobeIcon size={12} />
            Browser
          </span>
        </div>
        <BrowserUrlBar
          currentUrl={urlBarUrl}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          detectedUrls={detectedUrls}
          onBack={back}
          onForward={forward}
          onReload={reload}
          onNavigate={handleNavigate}
          onOpenExternal={handleOpenExternal}
        />
        <BrowserTabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onActivate={activateTab}
          onClose={closeTab}
          onNewTab={handleNewTab}
        />
      </div>
      <div className="browser-panel__body">
        {tabs.map((tab) => (
          <BrowserFrame
            key={tab.id}
            tabId={tab.id}
            url={tab.history[tab.cursor] ?? BROWSER_HOME_URL}
            reloadNonce={tab.reloadNonce}
            active={tab.id === activeTabId}
            onLoad={markLoaded}
          />
        ))}
        {!activeTab && (
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
