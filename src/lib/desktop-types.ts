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
};

declare global {
  interface Window {
    skeinDesktop?: SkeinDesktopApi;
  }
}

export {};
