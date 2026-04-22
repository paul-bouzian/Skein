import type {
  DesktopDialogOpenOptions,
  DesktopDialogOptions,
  DesktopNotification,
  DesktopNotificationPermission,
  DesktopUpdate,
  DesktopUpdateDownloadEvent,
} from "./desktop-types";
import { requireDesktopApi } from "./desktop-host";

function requireDesktopShell() {
  return requireDesktopApi(
    "Desktop shell is unavailable. Launch Skein with `bun run electron:dev`.",
  );
}

export const dialog = {
  confirm(
    message: string,
    options?: DesktopDialogOptions,
  ): Promise<boolean> {
    return requireDesktopShell().dialog.confirm(message, options);
  },

  message(message: string, options?: DesktopDialogOptions): Promise<void> {
    return requireDesktopShell().dialog.message(message, options);
  },

  open(
    options?: DesktopDialogOpenOptions,
  ): Promise<string | string[] | null> {
    return requireDesktopShell().dialog.open(options);
  },
};

export function openExternalUrl(url: string): Promise<void> {
  return requireDesktopShell().shell.openExternal(url);
}

export const menuShell = {
  setOpenSettingsShortcut(shortcut: string | null): Promise<void> {
    return requireDesktopShell().menu.setOpenSettingsShortcut(shortcut);
  },
};

export const notifications = {
  getPermissionState(): Promise<DesktopNotificationPermission> {
    return requireDesktopShell().notifications.getPermissionState();
  },

  requestPermission(): Promise<"granted" | "denied"> {
    return requireDesktopShell().notifications.requestPermission();
  },

  send(notification: DesktopNotification): Promise<void> {
    return requireDesktopShell().notifications.send(notification);
  },
};

export const updater = {
  check(): Promise<DesktopUpdate | null> {
    return requireDesktopShell().updater.check();
  },

  close(updateId: string): Promise<void> {
    return requireDesktopShell().updater.close(updateId);
  },

  downloadAndInstall(
    updateId: string,
    onEvent?: (event: DesktopUpdateDownloadEvent) => void,
  ): Promise<void> {
    return requireDesktopShell().updater.downloadAndInstall(updateId, onEvent);
  },
};

export const windowShell = {
  getPathForFile(file: File): string | null {
    return requireDesktopShell().window.getPathForFile(file);
  },
};
