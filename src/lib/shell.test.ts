import { beforeEach, describe, expect, it } from "vitest";

import {
  dialogConfirmMock,
  notificationGetPermissionStateMock,
  openExternalMock,
  updaterCloseMock,
  updaterCheckMock,
  updaterDownloadAndInstallMock,
  windowGetPathForFileMock,
} from "../test/desktop-mock";
import {
  dialog,
  notifications,
  openExternalUrl,
  updater,
  windowShell,
} from "./shell";

describe("shell", () => {
  beforeEach(() => {
    dialogConfirmMock.mockReset();
    notificationGetPermissionStateMock.mockReset();
    openExternalMock.mockReset();
    updaterCheckMock.mockReset();
    updaterCloseMock.mockReset();
    updaterDownloadAndInstallMock.mockReset();
    windowGetPathForFileMock.mockReset();
  });

  it("routes dialog.confirm through the desktop host", async () => {
    dialogConfirmMock.mockResolvedValue(true);

    await expect(dialog.confirm("Continue?")).resolves.toBe(true);
    expect(dialogConfirmMock).toHaveBeenCalledWith("Continue?", undefined);
  });

  it("opens external URLs through the desktop host", async () => {
    openExternalMock.mockResolvedValue(undefined);

    await openExternalUrl("https://example.com");

    expect(openExternalMock).toHaveBeenCalledWith("https://example.com");
  });

  it("reads notification permission from the desktop host", async () => {
    notificationGetPermissionStateMock.mockResolvedValue("granted");

    await expect(notifications.getPermissionState()).resolves.toBe("granted");
    expect(notificationGetPermissionStateMock).toHaveBeenCalledTimes(1);
  });

  it("passes updater checks through the desktop host", async () => {
    const update = {
      id: "offer-1",
      currentVersion: "0.1.0",
      version: "0.2.0",
    };
    updaterCheckMock.mockResolvedValue(update);

    await expect(updater.check()).resolves.toBe(update);
    expect(updaterCheckMock).toHaveBeenCalledTimes(1);
  });

  it("routes updater actions through the desktop host", async () => {
    updaterCloseMock.mockResolvedValue(undefined);
    updaterDownloadAndInstallMock.mockResolvedValue(undefined);

    await updater.close("offer-1");
    await updater.downloadAndInstall("offer-1");

    expect(updaterCloseMock).toHaveBeenCalledWith("offer-1");
    expect(updaterDownloadAndInstallMock).toHaveBeenCalledWith(
      "offer-1",
      undefined,
    );
  });

  it("reads file paths through the desktop host", () => {
    const file = { path: "/tmp/example.png" } as File & { path: string };
    windowGetPathForFileMock.mockReturnValue("/tmp/example.png");

    expect(windowShell.getPathForFile(file)).toBe("/tmp/example.png");
  });

  it("fails fast when the desktop shell is absent", async () => {
    delete window.skeinDesktop;

    expect(() => openExternalUrl("https://example.com")).toThrow(
      "Desktop shell is unavailable",
    );
  });
});
