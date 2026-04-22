import {
  Menu,
  MenuItemConstructorOptions,
  app,
  type BrowserWindow,
} from "electron";

import {
  APP_NAME,
  MENU_CHECK_FOR_UPDATES_EVENT_NAME,
  MENU_OPEN_SETTINGS_EVENT_NAME,
} from "../src/lib/app-identity.js";
import { toElectronAccelerator } from "../src/lib/shortcuts.js";

type MenuShortcuts = {
  openSettingsShortcut?: string | null;
};

const DEFAULT_OPEN_SETTINGS_SHORTCUT = "mod+comma";

function emitMenuEvent(mainWindow: BrowserWindow, eventName: string) {
  if (mainWindow.isDestroyed()) {
    return;
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
  mainWindow.webContents.send(`skein:event:${eventName}`, {
    payload: undefined,
  });
}

export function installApplicationMenu(
  mainWindow: BrowserWindow,
  shortcuts: MenuShortcuts = {},
) {
  const openSettingsAccelerator = toElectronAccelerator(
    shortcuts.openSettingsShortcut ?? DEFAULT_OPEN_SETTINGS_SHORTCUT,
  );
  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        {
          label: "Check for Updates…",
          click: () =>
            emitMenuEvent(mainWindow, MENU_CHECK_FOR_UPDATES_EVENT_NAME),
        },
        {
          label: "Settings…",
          accelerator: openSettingsAccelerator,
          click: () => emitMenuEvent(mainWindow, MENU_OPEN_SETTINGS_EVENT_NAME),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "close" },
      ],
    },
  ];

  if (!app.isPackaged) {
    template.push({
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
