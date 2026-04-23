import {
  BrowserWindow,
  Notification,
  app,
  dialog,
  ipcMain,
  shell,
} from "electron";
import { join } from "node:path";

import { APP_BUNDLE_ID, APP_NAME } from "../src/lib/app-identity.js";
import {
  assertDesktopBackendCommand,
  assertDesktopPayload,
  assertOpenExternalUrl,
} from "../src/lib/desktop-contract.js";
import type {
  DesktopDialogOpenOptions,
  DesktopDialogOptions,
} from "../src/lib/desktop-types.js";
import { BackendClient } from "./backend-client.js";
import { BrowserController } from "./browser-controller.js";
import { installApplicationMenu } from "./menu.js";
import { PreferencesStore } from "./preferences.js";
import { AppUpdater } from "./updater.js";

const appDataPath = app.getPath("appData");
app.setPath("userData", join(appDataPath, APP_BUNDLE_ID));
const preferencesStore = new PreferencesStore(
  join(app.getPath("userData"), "ui-prefs.json"),
);

const backendClient = new BackendClient({
  appDataDir: app.getPath("userData"),
  homeDir: app.getPath("home"),
  onEvent(eventName, payload) {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(`skein:event:${eventName}`, { payload });
    }
  },
});
const appUpdater = new AppUpdater();
let openSettingsShortcut: string | null | undefined;

function openMainWindow() {
  const mainWindow = createMainWindow();
  installApplicationMenu(mainWindow, { openSettingsShortcut });
  return mainWindow;
}

function buildDialogOptions(
  message: string,
  options?: DesktopDialogOptions,
  buttons?: string[],
) {
  return {
    type: options?.kind ?? "info",
    title: options?.title ?? APP_NAME,
    message,
    ...(buttons ? { buttons } : {}),
  } as const;
}

function createMainWindow() {
  const preferencesSnapshot = Buffer.from(
    JSON.stringify(preferencesStore.getSnapshot()),
    "utf8",
  ).toString("base64");
  const mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--skein-ui-prefs=${preferencesSnapshot}`],
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  new BrowserController(mainWindow);

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
}

function registerIpcHandlers() {
  ipcMain.handle(
    "skein:invoke",
    async (_event, command: string, payload?: unknown) => {
      const nextCommand = assertDesktopBackendCommand(command);
      const nextPayload = assertDesktopPayload(payload);

      if (command === "restart_app") {
        if (!appUpdater.restartToApplyUpdate()) {
          app.relaunch();
          app.quit();
        }
        return;
      }

      return backendClient.invoke(nextCommand, nextPayload);
    },
  );

  ipcMain.handle(
    "skein:dialog:confirm",
    async (_event, message: string, options?: DesktopDialogOptions) => {
      const result = await dialog.showMessageBox({
        ...buildDialogOptions(message, options, [
          options?.okLabel ?? "OK",
          options?.cancelLabel ?? "Cancel",
        ]),
        defaultId: 0,
        cancelId: 1,
      });
      return result.response === 0;
    },
  );

  ipcMain.handle(
    "skein:dialog:message",
    async (_event, message: string, options?: DesktopDialogOptions) => {
      await dialog.showMessageBox({
        ...buildDialogOptions(message, options, [options?.okLabel ?? "OK"]),
        defaultId: 0,
      });
    },
  );

  ipcMain.handle(
    "skein:dialog:open",
    async (_event, options?: DesktopDialogOpenOptions) => {
      const properties: Array<
        "openFile" | "openDirectory" | "multiSelections" | "createDirectory"
      > = [];
      properties.push(options?.directory ? "openDirectory" : "openFile");
      if (options?.multiple) {
        properties.push("multiSelections");
      }
      if (options?.canCreateDirectories) {
        properties.push("createDirectory");
      }

      const result = await dialog.showOpenDialog({
        title: options?.title,
        properties,
        filters: options?.filters,
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      if (options?.multiple) {
        return result.filePaths;
      }
      return result.filePaths[0] ?? null;
    },
  );

  ipcMain.handle("skein:shell:open-external", (_event, url: string) => {
    return shell.openExternal(assertOpenExternalUrl(url));
  });
  ipcMain.handle(
    "skein:menu:set-open-settings-shortcut",
    (event, shortcut: string | null) => {
      openSettingsShortcut = shortcut;
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window) {
        installApplicationMenu(window, { openSettingsShortcut });
      }
    },
  );

  ipcMain.handle("skein:notifications:send", (_event, payload: { title: string; body: string }) => {
    if (!Notification.isSupported()) {
      return;
    }

    new Notification(payload).show();
  });

  ipcMain.handle("skein:updater:check", () => appUpdater.check());
  ipcMain.handle("skein:updater:close", (_event, updateId: string) =>
    appUpdater.close(updateId),
  );
  ipcMain.handle(
    "skein:updater:download-and-install",
    (event, updateId: string, progressChannel: string) => {
      if (
        typeof progressChannel !== "string" ||
        !progressChannel.startsWith("skein:updater:download:") ||
        progressChannel.length <= "skein:updater:download:".length
      ) {
        throw new Error("Invalid updater progress channel.");
      }

      return appUpdater.downloadAndInstall(updateId, (downloadEvent) => {
        if (event.sender.isDestroyed()) {
          return;
        }
        try {
          event.sender.send(progressChannel, downloadEvent);
        } catch {
          /* ignore */
        }
      });
    },
  );

  ipcMain.handle(
    "skein:preferences:set",
    (_event, key: string, value: string | null) => preferencesStore.set(key, value),
  );
}

app.whenReady().then(async () => {
  await backendClient.start();
  registerIpcHandlers();
  openMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openMainWindow();
    }
  });
});

app.on("before-quit", () => {
  void backendClient.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
