import {
  type BrowserWindow,
  type Rectangle,
  WebContentsView,
  ipcMain,
  session,
} from "electron";

import {
  assertBrowserEnvId,
  assertBrowserTabId,
  assertBrowserUrl,
  assertPanelBounds,
} from "../src/lib/browser-contract.js";
import type {
  BrowserPanelBounds,
  BrowserTabEventMap,
  BrowserTabEventName,
} from "../src/lib/desktop-types.js";

const PARTITION = "persist:skein-browser";

const IPC_CHANNELS = [
  "skein:browser:create-tab",
  "skein:browser:destroy-tab",
  "skein:browser:destroy-env",
  "skein:browser:activate-tab",
  "skein:browser:navigate",
  "skein:browser:back",
  "skein:browser:forward",
  "skein:browser:reload",
  "skein:browser:set-panel-bounds",
  "skein:browser:open-devtools",
] as const;

type ManagedTab = {
  id: string;
  envId: string;
  view: WebContentsView;
  attached: boolean;
};

function assertPlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a plain object payload.");
  }
  return value as Record<string, unknown>;
}

export class BrowserController {
  private readonly window: BrowserWindow;
  private readonly tabs = new Map<string, ManagedTab>();
  private panelBounds: BrowserPanelBounds | null = null;
  private activeTabId: string | null = null;
  private disposed = false;

  constructor(window: BrowserWindow) {
    this.window = window;
    // `ipcMain.handle` is process-global. Skein is single-window, so we
    // expect the previous instance's `dispose()` to have cleared these
    // on window close — but defensively clear again before re-registering
    // to avoid "Cannot register two handlers" if a prior dispose raced
    // with the new window creation.
    for (const channel of IPC_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
    this.registerIpcHandlers();
    window.once("closed", () => {
      this.dispose();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const channel of IPC_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
    for (const tab of Array.from(this.tabs.values())) {
      this.closeTabView(tab);
    }
    this.tabs.clear();
    this.activeTabId = null;
    this.panelBounds = null;
  }

  private registerIpcHandlers(): void {
    ipcMain.handle("skein:browser:create-tab", async (_event, payload) => {
      const body = assertPlainObject(payload);
      const tabId = assertBrowserTabId(body.tabId);
      const envId = assertBrowserEnvId(body.envId);
      const initialUrl = assertBrowserUrl(body.initialUrl);
      this.createTab(tabId, envId, initialUrl);
    });

    ipcMain.handle("skein:browser:destroy-tab", async (_event, payload) => {
      const body = assertPlainObject(payload);
      this.destroyTab(assertBrowserTabId(body.tabId));
    });

    ipcMain.handle("skein:browser:destroy-env", async (_event, payload) => {
      const body = assertPlainObject(payload);
      this.destroyEnv(assertBrowserEnvId(body.envId));
    });

    ipcMain.handle("skein:browser:activate-tab", async (_event, payload) => {
      const body = assertPlainObject(payload);
      this.activateTab(
        body.tabId === null ? null : assertBrowserTabId(body.tabId),
      );
    });

    ipcMain.handle("skein:browser:navigate", async (_event, payload) => {
      const body = assertPlainObject(payload);
      const tabId = assertBrowserTabId(body.tabId);
      this.navigate(tabId, assertBrowserUrl(body.url));
    });

    ipcMain.handle("skein:browser:back", async (_event, payload) => {
      const body = assertPlainObject(payload);
      const tabId = assertBrowserTabId(body.tabId);
      this.back(tabId, assertBrowserUrl(body.targetUrl));
    });

    ipcMain.handle("skein:browser:forward", async (_event, payload) => {
      const body = assertPlainObject(payload);
      const tabId = assertBrowserTabId(body.tabId);
      this.forward(tabId, assertBrowserUrl(body.targetUrl));
    });

    ipcMain.handle("skein:browser:reload", async (_event, payload) => {
      const body = assertPlainObject(payload);
      this.reload(assertBrowserTabId(body.tabId), body.hard === true);
    });

    ipcMain.handle("skein:browser:set-panel-bounds", async (_event, payload) => {
      this.setPanelBounds(assertPanelBounds(payload));
    });

    ipcMain.handle("skein:browser:open-devtools", async (_event, payload) => {
      const body = assertPlainObject(payload);
      this.openDevTools(assertBrowserTabId(body.tabId));
    });
  }

  private createTab(tabId: string, envId: string, initialUrl: string): void {
    if (this.tabs.has(tabId)) return;
    const view = new WebContentsView({
      webPreferences: {
        session: session.fromPartition(PARTITION),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const tab: ManagedTab = { id: tabId, envId, view, attached: false };
    this.tabs.set(tabId, tab);
    this.wireWebContentsListeners(tab);
    this.attachIfReady(tab);
    if (this.activeTabId === tabId) {
      this.applyVisibility();
    }
    if (initialUrl && initialUrl !== "about:blank") {
      void view.webContents.loadURL(initialUrl).catch(() => {
        /* errors arrive via did-fail-load */
      });
    }
  }

  private destroyTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
    }
    this.closeTabView(tab);
  }

  private destroyEnv(envId: string): void {
    for (const tab of Array.from(this.tabs.values())) {
      if (tab.envId === envId) {
        this.destroyTab(tab.id);
      }
    }
  }

  private activateTab(tabId: string | null): void {
    this.activeTabId = tabId;
    this.applyVisibility();
  }

  private navigate(tabId: string, url: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    void tab.view.webContents.loadURL(url).catch(() => {
      /* errors arrive via did-fail-load */
    });
  }

  // Back/forward are driven by the renderer's Zustand history because
  // it's the single source of truth across env-switch recreations of
  // this WebContentsView. Using `navigationHistory.goBack/goForward`
  // here would desync once the native history is wiped but the store
  // still has entries — see PR #93 review thread.
  private back(tabId: string, targetUrl: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    void tab.view.webContents.loadURL(targetUrl).catch(() => {});
  }

  private forward(tabId: string, targetUrl: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    void tab.view.webContents.loadURL(targetUrl).catch(() => {});
  }

  private reload(tabId: string, hard: boolean): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (hard) {
      tab.view.webContents.reloadIgnoringCache();
    } else {
      tab.view.webContents.reload();
    }
  }

  private openDevTools(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.view.webContents.openDevTools({ mode: "detach" });
  }

  private setPanelBounds(bounds: BrowserPanelBounds | null): void {
    this.panelBounds = bounds;
    for (const tab of this.tabs.values()) {
      this.attachIfReady(tab);
    }
    this.applyVisibility();
  }

  private attachIfReady(tab: ManagedTab): void {
    if (tab.attached) return;
    if (!this.panelBounds) return;
    if (this.window.isDestroyed()) return;
    this.window.contentView.addChildView(tab.view);
    tab.attached = true;
  }

  private applyVisibility(): void {
    const bounds = this.panelBounds;
    for (const tab of this.tabs.values()) {
      const visible =
        tab.id === this.activeTabId && bounds !== null && tab.attached;
      tab.view.setVisible(visible);
      if (visible && bounds) {
        tab.view.setBounds(bounds as Rectangle);
      }
    }
  }

  private wireWebContentsListeners(tab: ManagedTab): void {
    const { webContents } = tab.view;

    webContents.on("did-start-loading", () => {
      this.emit("did-start-loading", { tabId: tab.id });
    });
    webContents.on("did-stop-loading", () => {
      this.emit("did-stop-loading", { tabId: tab.id });
    });
    webContents.on("did-navigate", (_event, url) => {
      this.emit("did-navigate", { tabId: tab.id, url, isInPlace: false });
    });
    webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.emit("did-navigate", { tabId: tab.id, url, isInPlace: true });
    });
    webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        this.emit("did-fail-load", {
          tabId: tab.id,
          url: validatedURL,
          errorCode,
          errorDescription,
        });
      },
    );
    webContents.on("page-title-updated", (_event, title) => {
      this.emit("page-title-updated", { tabId: tab.id, title });
    });
    webContents.on("page-favicon-updated", (_event, favicons) => {
      this.emit("page-favicon-updated", { tabId: tab.id, favicons });
    });
    webContents.on("will-navigate", (event, url) => {
      if (!isSafeNavigationUrl(url)) event.preventDefault();
    });
    webContents.setWindowOpenHandler(({ url, disposition }) => {
      if (isSafeNavigationUrl(url)) {
        this.emit("open-window-request", {
          sourceTabId: tab.id,
          url,
          disposition,
        });
      }
      return { action: "deny" };
    });
  }

  private closeTabView(tab: ManagedTab): void {
    const { webContents } = tab.view;
    try {
      if (tab.attached && !this.window.isDestroyed()) {
        this.window.contentView.removeChildView(tab.view);
      }
    } catch {
      /* ignore */
    }
    tab.attached = false;
    try {
      if (!webContents.isDestroyed()) {
        webContents.removeAllListeners();
        webContents.stop();
        // `waitForBeforeUnload: false` disposes unconditionally; the
        // default would honor `beforeunload` handlers and leak the
        // WebContents if the page refuses to close.
        webContents.close({ waitForBeforeUnload: false });
      }
    } catch {
      /* ignore — teardown races */
    }
  }

  private emit<K extends BrowserTabEventName>(
    name: K,
    payload: BrowserTabEventMap[K],
  ): void {
    if (this.disposed || this.window.isDestroyed()) return;
    const sender = this.window.webContents;
    if (sender.isDestroyed()) return;
    try {
      sender.send(`skein:browser:${name}`, payload);
    } catch {
      /* ignore — teardown races */
    }
  }
}

function isSafeNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
