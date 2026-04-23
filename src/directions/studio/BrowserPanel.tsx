import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { installBrowserBridge } from "../../lib/browser-bridge";
import { normalizeBrowserUrl } from "../../lib/browser-preview";
import { getDesktopApi } from "../../lib/desktop-host";
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
import { BrowserTabBar } from "./BrowserTabBar";
import { BrowserUrlBar } from "./BrowserUrlBar";
import { BrowserWebView } from "./BrowserWebView";
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
  const activeTabId = slot.activeTabId;
  const seededEnvIdsRef = useRef<Set<string>>(new Set());
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const openTab = useBrowserStore((state) => state.openTab);
  const closeTab = useBrowserStore((state) => state.closeTab);
  const activateTab = useBrowserStore((state) => state.activateTab);
  const navigate = useBrowserStore((state) => state.navigate);
  const back = useBrowserStore((state) => state.back);
  const forward = useBrowserStore((state) => state.forward);
  const reload = useBrowserStore((state) => state.reload);

  useEffect(() => installBrowserBridge(), []);

  // Report the body rect to the main process so WebContentsView can size
  // itself to the panel. `ResizeObserver` only fires on size changes, so
  // we also poll via rAF to catch pure position shifts driven by sibling
  // layout changes (sidebar toggle, diff panel open, etc.) that the
  // observer can't see. The poll is cheap — a single
  // `getBoundingClientRect` + dirty check per frame — and stops when the
  // panel is collapsed.
  useLayoutEffect(() => {
    const browser = getDesktopApi()?.browser;
    if (!browser) return;
    const element = bodyRef.current;
    if (!element || collapsed) {
      void browser.setPanelBounds(null).catch(() => {});
      return;
    }
    let rafId: number | null = null;
    let prevKey = "";
    const tick = () => {
      rafId = null;
      const rect = element.getBoundingClientRect();
      const key = `${rect.left}|${rect.top}|${rect.width}|${rect.height}`;
      if (key !== prevKey) {
        prevKey = key;
        if (rect.width === 0 || rect.height === 0) {
          void browser.setPanelBounds(null).catch(() => {});
        } else {
          void browser
            .setPanelBounds({
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
            })
            .catch(() => {});
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      void browser.setPanelBounds(null).catch(() => {});
    };
  }, [collapsed]);

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

  const handleNavigate = useCallback(
    (url: string) => {
      if (!environmentId) return;
      const normalized = normalizeBrowserUrl(url);
      if (!normalized) return;
      if (!activeTabId) {
        openTab(environmentId, normalized);
        return;
      }
      navigate(environmentId, normalized);
      void getDesktopApi()
        ?.browser.navigate(activeTabId, normalized)
        .catch(() => {});
    },
    [environmentId, activeTabId, openTab, navigate],
  );

  // Drop a detected dev-server URL into a pristine about:blank tab so the
  // user doesn't have to type it themselves.
  const detectedTopUrl = slot.detectedUrls[0]?.url ?? null;
  useEffect(() => {
    if (collapsed || !environmentId || !detectedTopUrl) return;
    if (!isPristineBlankTab(activeTab)) return;
    handleNavigate(detectedTopUrl);
  }, [collapsed, environmentId, detectedTopUrl, activeTab, handleNavigate]);

  const handleBack = useCallback(() => {
    if (!environmentId || !activeTabId || !activeTab) return;
    if (activeTab.cursor <= 0) return;
    const targetUrl = activeTab.history[activeTab.cursor - 1];
    if (!targetUrl) return;
    back(environmentId);
    void getDesktopApi()
      ?.browser.back(activeTabId, targetUrl)
      .catch(() => {});
  }, [environmentId, activeTabId, activeTab, back]);

  const handleForward = useCallback(() => {
    if (!environmentId || !activeTabId || !activeTab) return;
    if (activeTab.cursor >= activeTab.history.length - 1) return;
    const targetUrl = activeTab.history[activeTab.cursor + 1];
    if (!targetUrl) return;
    forward(environmentId);
    void getDesktopApi()
      ?.browser.forward(activeTabId, targetUrl)
      .catch(() => {});
  }, [environmentId, activeTabId, activeTab, forward]);

  const handleReload = useCallback(() => {
    if (!environmentId || !activeTabId) return;
    reload(environmentId);
    void getDesktopApi()?.browser.reload(activeTabId).catch(() => {});
  }, [environmentId, activeTabId, reload]);

  const handleOpenDevTools = useCallback(() => {
    if (!activeTabId) return;
    void getDesktopApi()?.browser.openDevTools(activeTabId).catch(() => {});
  }, [activeTabId]);

  const handleActivateTab = useCallback(
    (id: string) => {
      if (!environmentId) return;
      activateTab(environmentId, id);
    },
    [environmentId, activateTab],
  );

  const handleCloseTab = useCallback(
    (id: string) => {
      if (!environmentId) return;
      closeTab(environmentId, id);
    },
    [environmentId, closeTab],
  );

  const handleNewTab = useCallback(() => {
    if (!environmentId) return;
    openTab(environmentId);
  }, [environmentId, openTab]);

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
          canOpenDevTools={Boolean(activeTabId)}
          onBack={handleBack}
          onForward={handleForward}
          onReload={handleReload}
          onNavigate={handleNavigate}
          onOpenExternal={handleOpenExternal}
          onOpenDevTools={handleOpenDevTools}
        />
        <BrowserTabBar
          tabs={slot.tabs}
          activeTabId={activeTabId}
          onActivate={handleActivateTab}
          onClose={handleCloseTab}
          onNewTab={handleNewTab}
        />
      </div>
      <div className="browser-panel__body" ref={bodyRef}>
        {environmentId &&
          slot.tabs.map((tab) => (
            <BrowserWebView
              key={tab.id}
              tabId={tab.id}
              envId={environmentId}
              initialUrl={tab.history[tab.cursor] ?? BROWSER_HOME_URL}
              active={tab.id === activeTabId}
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
