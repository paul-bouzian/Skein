import { beforeEach, describe, expect, it, vi } from "vitest";

let isPackaged = true;
let currentVersion = "0.1.0";
let latestProgressHandler:
  | ((info: { transferred: number; total: number }) => void)
  | null = null;

const checkForUpdatesMock = vi.fn();
const downloadUpdateMock = vi.fn();
const quitAndInstallMock = vi.fn();

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class MockCancellationToken {
  cancel = vi.fn();
}

const mockUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: false,
  allowPrerelease: false,
  forceDevUpdateConfig: false,
  checkForUpdates: (...args: unknown[]) => checkForUpdatesMock(...args),
  downloadUpdate: (...args: unknown[]) => downloadUpdateMock(...args),
  quitAndInstall: (...args: unknown[]) => quitAndInstallMock(...args),
  on: vi.fn((event: string, handler: unknown) => {
    if (event === "download-progress") {
      latestProgressHandler = handler as (info: {
        transferred: number;
        total: number;
      }) => void;
    }
    return mockUpdater;
  }),
  off: vi.fn((event: string, handler: unknown) => {
    if (event === "download-progress" && latestProgressHandler === handler) {
      latestProgressHandler = null;
    }
    return mockUpdater;
  }),
};

vi.mock("electron", () => ({
  app: {
    getVersion: () => currentVersion,
    get isPackaged() {
      return isPackaged;
    },
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: mockUpdater,
  default: {
    autoUpdater: mockUpdater,
  },
  CancellationToken: MockCancellationToken,
}));

describe("AppUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isPackaged = true;
    currentVersion = "0.1.0";
    latestProgressHandler = null;
    delete process.env.SKEIN_ENABLE_DEV_UPDATER;
  });

  it("returns null when the updater is disabled in unpackaged development mode", async () => {
    isPackaged = false;
    const { AppUpdater } = await import("./updater.js");

    await expect(new AppUpdater().check()).resolves.toBeNull();
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it("checks, downloads, and prepares a packaged update", async () => {
    const cancellationToken = new MockCancellationToken();
    checkForUpdatesMock.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: {
        version: "0.2.0",
        releaseDate: "2026-04-21T10:00:00Z",
        releaseNotes: "Adds Electron auto-update support.",
      },
      cancellationToken,
    });
    downloadUpdateMock.mockImplementation(async () => {
      latestProgressHandler?.({ transferred: 40, total: 100 });
      latestProgressHandler?.({ transferred: 100, total: 100 });
      return ["/tmp/Skein-0.2.0.zip"];
    });

    const { AppUpdater } = await import("./updater.js");
    const updater = new AppUpdater();
    const update = await updater.check();

    expect(update).not.toBeNull();
    expect(update?.id).toBe("offer-1");
    expect(update?.version).toBe("0.2.0");
    expect(update?.body).toBe("Adds Electron auto-update support.");

    const events: Array<unknown> = [];
    await updater.downloadAndInstall(update!.id, (event) => {
      events.push(event);
    });

    expect(events).toEqual([
      {
        event: "Started",
        data: { contentLength: 100 },
      },
      {
        event: "Progress",
        data: { chunkLength: 40 },
      },
      {
        event: "Progress",
        data: { chunkLength: 60 },
      },
      {
        event: "Finished",
      },
    ]);

    expect(cancellationToken.cancel).toHaveBeenCalledTimes(1);
    expect(updater.restartToApplyUpdate()).toBe(true);
    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a queued duplicate install for the same offer", async () => {
    const cancellationToken = new MockCancellationToken();
    const downloadDeferred = createDeferred<string[]>();
    checkForUpdatesMock.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: {
        version: "0.2.0",
        releaseDate: "2026-04-21T10:00:00Z",
        releaseNotes: "Adds Electron auto-update support.",
      },
      cancellationToken,
    });
    downloadUpdateMock.mockReturnValue(downloadDeferred.promise);

    const { AppUpdater } = await import("./updater.js");
    const updater = new AppUpdater();
    const update = await updater.check();

    const firstInstall = updater.downloadAndInstall(update!.id);
    const secondInstall = updater.downloadAndInstall(update!.id);
    downloadDeferred.resolve(["/tmp/Skein-0.2.0.zip"]);

    await expect(firstInstall).resolves.toBeUndefined();
    await expect(secondInstall).rejects.toThrow(
      "This update is no longer active.",
    );
  });
});
