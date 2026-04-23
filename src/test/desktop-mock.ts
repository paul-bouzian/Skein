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
export const browserCreateTabMock = vi.fn<
  SkeinDesktopApi["browser"]["createTab"]
>();
export const browserDestroyTabMock = vi.fn<
  SkeinDesktopApi["browser"]["destroyTab"]
>();
export const browserDestroyEnvMock = vi.fn<
  SkeinDesktopApi["browser"]["destroyEnv"]
>();
export const browserActivateTabMock = vi.fn<
  SkeinDesktopApi["browser"]["activateTab"]
>();
export const browserNavigateMock = vi.fn<
  SkeinDesktopApi["browser"]["navigate"]
>();
export const browserBackMock = vi.fn<SkeinDesktopApi["browser"]["back"]>();
export const browserForwardMock = vi.fn<
  SkeinDesktopApi["browser"]["forward"]
>();
export const browserReloadMock = vi.fn<SkeinDesktopApi["browser"]["reload"]>();
export const browserSetPanelBoundsMock = vi.fn<
  SkeinDesktopApi["browser"]["setPanelBounds"]
>();
export const browserOpenDevToolsMock = vi.fn<
  SkeinDesktopApi["browser"]["openDevTools"]
>();
export const browserOnTabEventMock = vi.fn<
  SkeinDesktopApi["browser"]["onTabEvent"]
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
    browser: {
      createTab: browserCreateTabMock,
      destroyTab: browserDestroyTabMock,
      destroyEnv: browserDestroyEnvMock,
      activateTab: browserActivateTabMock,
      navigate: browserNavigateMock,
      back: browserBackMock,
      forward: browserForwardMock,
      reload: browserReloadMock,
      setPanelBounds: browserSetPanelBoundsMock,
      openDevTools: browserOpenDevToolsMock,
      onTabEvent: browserOnTabEventMock,
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
  browserCreateTabMock.mockReset();
  browserDestroyTabMock.mockReset();
  browserDestroyEnvMock.mockReset();
  browserActivateTabMock.mockReset();
  browserNavigateMock.mockReset();
  browserBackMock.mockReset();
  browserForwardMock.mockReset();
  browserReloadMock.mockReset();
  browserSetPanelBoundsMock.mockReset();
  browserOpenDevToolsMock.mockReset();
  browserOnTabEventMock.mockReset();

  browserCreateTabMock.mockResolvedValue();
  browserDestroyTabMock.mockResolvedValue();
  browserDestroyEnvMock.mockResolvedValue();
  browserActivateTabMock.mockResolvedValue();
  browserNavigateMock.mockResolvedValue();
  browserBackMock.mockResolvedValue();
  browserForwardMock.mockResolvedValue();
  browserReloadMock.mockResolvedValue();
  browserSetPanelBoundsMock.mockResolvedValue();
  browserOpenDevToolsMock.mockResolvedValue();
  browserOnTabEventMock.mockImplementation(() => () => undefined);

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
