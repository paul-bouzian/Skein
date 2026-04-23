export type HostUnlistenFn = () => void;

export type HostEvent<T> = {
  payload: T;
};

export type DesktopDialogKind = "info" | "warning" | "error";

export type DesktopDialogOptions = {
  title?: string;
  kind?: DesktopDialogKind;
  okLabel?: string;
  cancelLabel?: string;
};

export type DesktopDialogFilter = {
  name: string;
  extensions: string[];
};

export type DesktopDialogOpenOptions = {
  title?: string;
  directory?: boolean;
  multiple?: boolean;
  canCreateDirectories?: boolean;
  filters?: DesktopDialogFilter[];
};

export type DesktopNotificationPermission = "default" | "granted" | "denied";

export type DesktopNotification = {
  title: string;
  body: string;
};

export type DesktopUpdateDownloadEvent =
  | {
      event: "Started";
      data: {
        contentLength?: number | null;
      };
    }
  | {
      event: "Progress";
      data: {
        chunkLength: number;
      };
    }
  | {
      event: "Finished";
    };

export type DesktopUpdate = {
  id: string;
  currentVersion: string;
  version: string;
  date?: string | null;
  body?: string | null;
};

export type DesktopPreferencesApi = {
  getSnapshot(): Record<string, string>;
  set(key: string, value: string | null): Promise<void>;
};

export type BrowserPanelBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserTabEventMap = {
  "did-start-loading": { tabId: string };
  "did-stop-loading": { tabId: string };
  "did-navigate": { tabId: string; url: string; isInPlace: boolean };
  "did-fail-load": {
    tabId: string;
    url: string;
    errorCode: number;
    errorDescription: string;
  };
  "page-title-updated": { tabId: string; title: string };
  "page-favicon-updated": { tabId: string; favicons: string[] };
  "open-window-request": {
    sourceTabId: string;
    url: string;
    disposition: string;
  };
};

export type BrowserTabEventName = keyof BrowserTabEventMap;

export type SkeinBrowserApi = {
  createTab(args: {
    tabId: string;
    envId: string;
    initialUrl: string;
  }): Promise<void>;
  destroyTab(tabId: string): Promise<void>;
  destroyEnv(envId: string): Promise<void>;
  activateTab(tabId: string | null): Promise<void>;
  navigate(tabId: string, url: string): Promise<void>;
  back(tabId: string, targetUrl: string): Promise<void>;
  forward(tabId: string, targetUrl: string): Promise<void>;
  reload(tabId: string, hard?: boolean): Promise<void>;
  setPanelBounds(bounds: BrowserPanelBounds | null): Promise<void>;
  openDevTools(tabId: string): Promise<void>;
  onTabEvent<K extends BrowserTabEventName>(
    kind: K,
    handler: (payload: BrowserTabEventMap[K]) => void,
  ): HostUnlistenFn;
};

export type SkeinDesktopApi = {
  invoke<T>(command: string, payload?: Record<string, unknown>): Promise<T>;
  listen<T>(
    eventName: string,
    handler: (event: HostEvent<T>) => void,
  ): Promise<HostUnlistenFn>;
  dialog: {
    confirm(
      message: string,
      options?: DesktopDialogOptions,
    ): Promise<boolean>;
    message(message: string, options?: DesktopDialogOptions): Promise<void>;
    open(
      options?: DesktopDialogOpenOptions,
    ): Promise<string | string[] | null>;
  };
  shell: {
    openExternal(url: string): Promise<void>;
  };
  menu: {
    setOpenSettingsShortcut(shortcut: string | null): Promise<void>;
  };
  notifications: {
    send(notification: DesktopNotification): Promise<void>;
    getPermissionState(): Promise<DesktopNotificationPermission>;
    requestPermission(): Promise<Exclude<DesktopNotificationPermission, "default">>;
  };
  updater: {
    check(): Promise<DesktopUpdate | null>;
    close(updateId: string): Promise<void>;
    downloadAndInstall(
      updateId: string,
      onEvent?: (event: DesktopUpdateDownloadEvent) => void,
    ): Promise<void>;
  };
  preferences?: DesktopPreferencesApi;
  window: {
    getPathForFile(file: File): string | null;
  };
  browser: SkeinBrowserApi;
};

declare global {
  interface Window {
    skeinDesktop?: SkeinDesktopApi;
  }
}

export {};
