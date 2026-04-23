import { getDesktopApi } from "./desktop-host";
import { findEnvIdForTab, useBrowserStore } from "../stores/browser-store";
import type { HostUnlistenFn } from "./desktop-types";

export function installBrowserBridge(): HostUnlistenFn {
  const api = getDesktopApi();
  if (!api) return () => {};

  const { browser } = api;
  const store = useBrowserStore;

  const offs: HostUnlistenFn[] = [
    browser.onTabEvent("did-start-loading", ({ tabId }) => {
      store.getState().markPending(tabId, true);
    }),
    browser.onTabEvent("did-stop-loading", ({ tabId }) => {
      store.getState().markPending(tabId, false);
    }),
    browser.onTabEvent("did-navigate", ({ tabId, url, isInPlace }) => {
      store.getState().navigateFromMain(tabId, url, isInPlace);
    }),
    browser.onTabEvent("did-fail-load", ({ tabId }) => {
      store.getState().markPending(tabId, false);
    }),
    browser.onTabEvent("page-title-updated", ({ tabId, title }) => {
      store.getState().setTitle(tabId, title);
    }),
    browser.onTabEvent("page-favicon-updated", ({ tabId, favicons }) => {
      store.getState().setFavicon(tabId, favicons[0] ?? null);
    }),
    browser.onTabEvent("open-window-request", ({ sourceTabId, url }) => {
      const state = store.getState();
      const envId = findEnvIdForTab(state.byEnv, sourceTabId);
      if (envId) state.openTab(envId, url);
    }),
  ];

  return () => {
    for (const fn of offs) fn();
  };
}
