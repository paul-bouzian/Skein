import { contextBridge, ipcRenderer, webUtils } from "electron";

import { assertBrowserTabEventName } from "../src/lib/browser-contract.js";
import {
  assertDesktopBackendCommand,
  assertDesktopEventName,
  assertDesktopPayload,
  assertOpenExternalUrl,
} from "../src/lib/desktop-contract.js";
import type {
  BrowserPanelBounds,
  BrowserTabEventMap,
  BrowserTabEventName,
  DesktopDialogOpenOptions,
  DesktopDialogOptions,
  DesktopNotification,
  DesktopNotificationPermission,
  DesktopUpdate,
  DesktopUpdateDownloadEvent,
  HostEvent,
  HostUnlistenFn,
  SkeinDesktopApi,
} from "../src/lib/desktop-types.js";

type NotificationPermissionResult = Exclude<
  DesktopNotificationPermission,
  "default"
>;

function getPermissionState(): DesktopNotificationPermission {
  if (typeof Notification === "undefined") {
    return "default";
  }

  return Notification.permission;
}

async function requestPermission(): Promise<NotificationPermissionResult> {
  if (typeof Notification === "undefined") {
    return "denied";
  }

  const result = await Notification.requestPermission();
  return result === "granted" ? "granted" : "denied";
}

function readPreferencesSnapshot() {
  const argument = process.argv.find((value) =>
    value.startsWith("--skein-ui-prefs="),
  );
  if (!argument) {
    return {};
  }

  const encoded = argument.slice("--skein-ui-prefs=".length);
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

const preferencesSnapshot = readPreferencesSnapshot();
let preferenceWriteChain: Promise<void> = Promise.resolve();

const skeinDesktop: SkeinDesktopApi = {
  invoke<T>(command: string, payload?: Record<string, unknown>) {
    return ipcRenderer.invoke(
      "skein:invoke",
      assertDesktopBackendCommand(command),
      assertDesktopPayload(payload),
    ) as Promise<T>;
  },

  async listen<T>(
    eventName: string,
    handler: (event: HostEvent<T>) => void,
  ): Promise<HostUnlistenFn> {
    const channel = `skein:event:${assertDesktopEventName(eventName)}`;
    const listener = (_event: unknown, payload: HostEvent<T>) => {
      handler(payload);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },

  dialog: {
    confirm(message: string, options?: DesktopDialogOptions) {
      return ipcRenderer.invoke("skein:dialog:confirm", message, options);
    },
    message(message: string, options?: DesktopDialogOptions) {
      return ipcRenderer.invoke("skein:dialog:message", message, options);
    },
    open(options?: DesktopDialogOpenOptions) {
      return ipcRenderer.invoke("skein:dialog:open", options);
    },
  },

  shell: {
    openExternal(url: string) {
      return ipcRenderer.invoke(
        "skein:shell:open-external",
        assertOpenExternalUrl(url),
      );
    },
  },

  menu: {
    setOpenSettingsShortcut(shortcut: string | null) {
      return ipcRenderer.invoke(
        "skein:menu:set-open-settings-shortcut",
        shortcut,
      );
    },
  },

  notifications: {
    send(notification: DesktopNotification) {
      return ipcRenderer.invoke("skein:notifications:send", notification);
    },
    async getPermissionState() {
      return getPermissionState();
    },
    requestPermission,
  },

  updater: {
    check(): Promise<DesktopUpdate | null> {
      return ipcRenderer.invoke("skein:updater:check");
    },
    close(updateId: string) {
      return ipcRenderer.invoke("skein:updater:close", updateId);
    },
    async downloadAndInstall(updateId: string, onEvent) {
      const progressChannel = `skein:updater:download:${updateId}:${crypto.randomUUID()}`;
      const listener = (_event: unknown, event: unknown) => {
        onEvent?.(event as DesktopUpdateDownloadEvent);
      };
      ipcRenderer.on(progressChannel, listener);
      try {
        await ipcRenderer.invoke(
          "skein:updater:download-and-install",
          updateId,
          progressChannel,
        );
      } finally {
        ipcRenderer.removeListener(progressChannel, listener);
      }
    },
  },

  preferences: {
    getSnapshot() {
      return { ...preferencesSnapshot };
    },
    set(key: string, value: string | null) {
      const writeTask = preferenceWriteChain.then(
        () => persistPreference(key, value),
        () => persistPreference(key, value),
      );
      preferenceWriteChain = writeTask.then(
        () => undefined,
        () => undefined,
      );
      return writeTask;
    },
  },

  window: {
    getPathForFile(file: File) {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return null;
      }
    },
  },

  browser: {
    createTab(args: { tabId: string; envId: string; initialUrl: string }) {
      return ipcRenderer.invoke("skein:browser:create-tab", args);
    },
    destroyTab(tabId: string) {
      return ipcRenderer.invoke("skein:browser:destroy-tab", { tabId });
    },
    destroyEnv(envId: string) {
      return ipcRenderer.invoke("skein:browser:destroy-env", { envId });
    },
    activateTab(tabId: string | null) {
      return ipcRenderer.invoke("skein:browser:activate-tab", { tabId });
    },
    navigate(tabId: string, url: string) {
      return ipcRenderer.invoke("skein:browser:navigate", { tabId, url });
    },
    back(tabId: string, targetUrl: string) {
      return ipcRenderer.invoke("skein:browser:back", { tabId, targetUrl });
    },
    forward(tabId: string, targetUrl: string) {
      return ipcRenderer.invoke("skein:browser:forward", { tabId, targetUrl });
    },
    reload(tabId: string, hard?: boolean) {
      return ipcRenderer.invoke("skein:browser:reload", { tabId, hard });
    },
    setPanelBounds(bounds: BrowserPanelBounds | null) {
      return ipcRenderer.invoke("skein:browser:set-panel-bounds", bounds);
    },
    openDevTools(tabId: string) {
      return ipcRenderer.invoke("skein:browser:open-devtools", { tabId });
    },
    onTabEvent<K extends BrowserTabEventName>(
      kind: K,
      handler: (payload: BrowserTabEventMap[K]) => void,
    ): HostUnlistenFn {
      const channel = `skein:browser:${assertBrowserTabEventName(kind)}`;
      const listener = (_event: unknown, payload: BrowserTabEventMap[K]) => {
        handler(payload);
      };
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld("skeinDesktop", skeinDesktop);

async function persistPreference(key: string, value: string | null) {
  const previousValue = preferencesSnapshot[key];
  if (value === null) {
    delete preferencesSnapshot[key];
  } else {
    preferencesSnapshot[key] = value;
  }

  try {
    await ipcRenderer.invoke("skein:preferences:set", key, value);
  } catch (error) {
    if (typeof previousValue === "string") {
      preferencesSnapshot[key] = previousValue;
    } else {
      delete preferencesSnapshot[key];
    }
    throw error;
  }
}
