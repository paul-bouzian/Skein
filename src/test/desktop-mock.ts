import { vi } from "vitest";

import type {
  DesktopNotificationPermission,
  DesktopUpdate,
  HostEvent,
  HostUnlistenFn,
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
export const windowGetPathForFileMock = vi.fn<
  SkeinDesktopApi["window"]["getPathForFile"]
>();
export const windowOnDragDropEventMock = vi.fn<
  NonNullable<SkeinDesktopApi["window"]["onDragDropEvent"]>
>();

const defaultUnlisten: HostUnlistenFn = () => undefined;
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
      snapshot: defaultPreferencesSnapshot,
      set: preferenceSetMock,
    },
    window: {
      getPathForFile: windowGetPathForFileMock,
      onDragDropEvent: windowOnDragDropEventMock,
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
  notificationSendMock.mockReset();
  notificationGetPermissionStateMock.mockReset();
  notificationRequestPermissionMock.mockReset();
  updaterCheckMock.mockReset();
  updaterCloseMock.mockReset();
  updaterDownloadAndInstallMock.mockReset();
  preferenceSetMock.mockReset();
  windowGetPathForFileMock.mockReset();
  windowOnDragDropEventMock.mockReset();

  desktopInvokeMock.mockImplementation(async () => undefined);
  desktopListenMock.mockImplementation(async () => defaultUnlisten);
  dialogConfirmMock.mockResolvedValue(true);
  dialogMessageMock.mockResolvedValue();
  dialogOpenMock.mockResolvedValue(null);
  openExternalMock.mockResolvedValue();
  notificationSendMock.mockResolvedValue();
  notificationGetPermissionStateMock.mockResolvedValue(
    "default" satisfies DesktopNotificationPermission,
  );
  notificationRequestPermissionMock.mockResolvedValue("denied");
  updaterCheckMock.mockResolvedValue(null as DesktopUpdate | null);
  updaterCloseMock.mockResolvedValue();
  updaterDownloadAndInstallMock.mockResolvedValue();
  preferenceSetMock.mockResolvedValue();
  windowGetPathForFileMock.mockImplementation((file: File) => {
    return (file as File & { path?: string }).path ?? null;
  });
  windowOnDragDropEventMock.mockImplementation(async () => defaultUnlisten);

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
