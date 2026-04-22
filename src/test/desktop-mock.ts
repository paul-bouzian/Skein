import { vi } from "vitest";

import type {
  DesktopNotificationPermission,
  DesktopUpdate,
  HostEvent,
  SkeinDesktopApi,
} from "../lib/desktop-types";

export const desktopInvokeMock = vi.fn<
  SkeinDesktopApi["invoke"]
>();
export const desktopListenMock = vi.fn<
  SkeinDesktopApi["listen"]
>();
export const dialogConfirmMock = vi.fn<
  SkeinDesktopApi["dialog"]["confirm"]
>();
export const dialogMessageMock = vi.fn<
  SkeinDesktopApi["dialog"]["message"]
>();
export const dialogOpenMock = vi.fn<
  SkeinDesktopApi["dialog"]["open"]
>();
export const openExternalMock = vi.fn<
  SkeinDesktopApi["shell"]["openExternal"]
>();
export const menuSetOpenSettingsShortcutMock = vi.fn<
  SkeinDesktopApi["menu"]["setOpenSettingsShortcut"]
>();
export const notificationSendMock = vi.fn<
  SkeinDesktopApi["notifications"]["send"]
>();
export const notificationGetPermissionStateMock = vi.fn<
  SkeinDesktopApi["notifications"]["getPermissionState"]
>();
export const notificationRequestPermissionMock = vi.fn<
  SkeinDesktopApi["notifications"]["requestPermission"]
>();
export const updaterCheckMock = vi.fn<
  SkeinDesktopApi["updater"]["check"]
>();
export const updaterCloseMock = vi.fn<
  SkeinDesktopApi["updater"]["close"]
>();
export const updaterDownloadAndInstallMock = vi.fn<
  SkeinDesktopApi["updater"]["downloadAndInstall"]
>();
export const preferenceSetMock = vi.fn<
  NonNullable<SkeinDesktopApi["preferences"]>["set"]
>();
export const preferenceGetSnapshotMock = vi.fn<
  NonNullable<SkeinDesktopApi["preferences"]>["getSnapshot"]
>();
export const windowGetPathForFileMock = vi.fn<
  SkeinDesktopApi["window"]["getPathForFile"]
>();

const defaultPreferencesSnapshot: Record<string, string> = {};

function createDesktopMock(): SkeinDesktopApi {
  return {
    invoke: ((command, payload) =>
      desktopInvokeMock(command, payload)) as SkeinDesktopApi["invoke"],
    listen: ((eventName, handler) =>
      desktopListenMock(
        eventName,
        handler as (event: HostEvent<unknown>) => void,
      )) as SkeinDesktopApi["listen"],
    dialog: {
      confirm: dialogConfirmMock,
      message: dialogMessageMock,
      open: dialogOpenMock,
    },
    shell: {
      openExternal: openExternalMock,
    },
    menu: {
      setOpenSettingsShortcut: menuSetOpenSettingsShortcutMock,
    },
    notifications: {
      send: notificationSendMock,
      getPermissionState: notificationGetPermissionStateMock,
      requestPermission: notificationRequestPermissionMock,
    },
    updater: {
      check: updaterCheckMock,
      close: updaterCloseMock,
      downloadAndInstall: updaterDownloadAndInstallMock,
    },
    preferences: {
      getSnapshot: preferenceGetSnapshotMock,
      set: preferenceSetMock,
    },
    window: {
      getPathForFile: windowGetPathForFileMock,
    },
  };
}

export function resetDesktopMock() {
  desktopInvokeMock.mockReset();
  desktopListenMock.mockReset();
  dialogConfirmMock.mockReset();
  dialogMessageMock.mockReset();
  dialogOpenMock.mockReset();
  openExternalMock.mockReset();
  menuSetOpenSettingsShortcutMock.mockReset();
  notificationSendMock.mockReset();
  notificationGetPermissionStateMock.mockReset();
  notificationRequestPermissionMock.mockReset();
  updaterCheckMock.mockReset();
  updaterCloseMock.mockReset();
  updaterDownloadAndInstallMock.mockReset();
  preferenceGetSnapshotMock.mockReset();
  preferenceSetMock.mockReset();
  windowGetPathForFileMock.mockReset();

  desktopInvokeMock.mockImplementation(async () => undefined);
  desktopListenMock.mockImplementation(async () => () => undefined);
  dialogConfirmMock.mockResolvedValue(true);
  dialogMessageMock.mockResolvedValue();
  dialogOpenMock.mockResolvedValue(null);
  openExternalMock.mockResolvedValue();
  menuSetOpenSettingsShortcutMock.mockResolvedValue();
  notificationSendMock.mockResolvedValue();
  notificationGetPermissionStateMock.mockResolvedValue(
    "default" satisfies DesktopNotificationPermission,
  );
  notificationRequestPermissionMock.mockResolvedValue("denied");
  updaterCheckMock.mockResolvedValue(null as DesktopUpdate | null);
  updaterCloseMock.mockResolvedValue();
  updaterDownloadAndInstallMock.mockResolvedValue();
  preferenceGetSnapshotMock.mockImplementation(() => ({
    ...defaultPreferencesSnapshot,
  }));
  preferenceSetMock.mockResolvedValue();
  windowGetPathForFileMock.mockImplementation((file: File) => {
    return (file as File & { path?: string }).path ?? null;
  });

  for (const key of Object.keys(defaultPreferencesSnapshot)) {
    delete defaultPreferencesSnapshot[key];
  }
}

export function setDesktopPreferenceSnapshot(snapshot: Record<string, string>) {
  for (const key of Object.keys(defaultPreferencesSnapshot)) {
    delete defaultPreferencesSnapshot[key];
  }
  Object.assign(defaultPreferencesSnapshot, snapshot);
}

export function installDesktopMock() {
  window.skeinDesktop = createDesktopMock();
  resetDesktopMock();
}
