import { useEffect } from "react";

import { getDesktopApi } from "../../lib/desktop-host";

type Props = {
  tabId: string;
  envId: string;
  initialUrl: string;
  active: boolean;
};

export function BrowserWebView({ tabId, envId, initialUrl, active }: Props) {
  useEffect(() => {
    const api = getDesktopApi();
    if (!api) return;
    void api.browser
      .createTab({ tabId, envId, initialUrl })
      .catch((error) => {
        console.error("browser.createTab failed:", error);
      });
    return () => {
      void api.browser.destroyTab(tabId).catch(() => {
        /* ignore teardown errors */
      });
    };
    // initialUrl is captured at mount-time by design; user navigation
    // flows through the IPC navigate channel, not this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, envId]);

  useEffect(() => {
    if (!active) return;
    const api = getDesktopApi();
    if (!api) return;
    void api.browser.activateTab(tabId).catch(() => {
      /* ignore */
    });
  }, [tabId, active]);

  return (
    <div
      className={`browser-webview ${active ? "" : "browser-webview--hidden"}`}
      data-testid="browser-webview"
      data-tab-id={tabId}
      aria-hidden={!active}
    />
  );
}
