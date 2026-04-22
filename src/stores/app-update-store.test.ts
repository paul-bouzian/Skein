import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import {
  openExternalMock,
  updaterCheckMock,
  updaterCloseMock,
  updaterDownloadAndInstallMock,
} from "../test/desktop-mock";
import { useAppUpdateStore } from "./app-update-store";



vi.mock("../lib/bridge", () => ({
  restartApp: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);

function makeUpdate(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "offer-1",
    currentVersion: "0.1.0",
    version: "0.2.0",
    date: "2026-04-04T10:00:00Z",
    body: "Adds native updater support.",
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

beforeEach(async () => {
  useAppUpdateStore.getState().dismiss();
  vi.clearAllMocks();
  useAppUpdateStore.setState({
    state: "idle",
    snapshot: null,
    error: null,
    downloadedBytes: 0,
    contentLength: null,
    noticeVisible: false,
    hasInitialized: false,
  });
});

describe("app-update-store", () => {
  it("exposes a pending release after a successful check", async () => {
    updaterCheckMock.mockResolvedValue(makeUpdate());

    await useAppUpdateStore.getState().initialize();

    expect(useAppUpdateStore.getState().state).toBe("available");
    expect(useAppUpdateStore.getState().noticeVisible).toBe(true);
    expect(useAppUpdateStore.getState().snapshot?.releaseUrl).toBe(
      "https://github.com/paul-bouzian/Skein/releases/tag/v0.2.0",
    );
  });

  it("announces when no update is available after a manual check", async () => {
    updaterCheckMock.mockResolvedValue(null);

    await useAppUpdateStore.getState().checkNow();

    expect(useAppUpdateStore.getState().state).toBe("latest");
    expect(useAppUpdateStore.getState().noticeVisible).toBe(true);
  });

  it("replays a manual check after the silent startup check finishes", async () => {
    const silentCheck = createDeferred<ReturnType<typeof makeUpdate> | null>();
    updaterCheckMock
      .mockImplementationOnce(() => silentCheck.promise)
      .mockResolvedValueOnce(null);

    const initializePromise = useAppUpdateStore.getState().initialize();
    const manualCheckPromise = useAppUpdateStore.getState().checkNow();

    expect(updaterCheckMock).toHaveBeenCalledTimes(1);

    silentCheck.resolve(null);
    await initializePromise;
    await manualCheckPromise;

    expect(updaterCheckMock).toHaveBeenCalledTimes(2);
    expect(useAppUpdateStore.getState().state).toBe("latest");
    expect(useAppUpdateStore.getState().noticeVisible).toBe(true);
  });

  it("runs initialize only once across the app lifetime", async () => {
    updaterCheckMock.mockResolvedValue(null);

    await useAppUpdateStore.getState().initialize();
    await useAppUpdateStore.getState().initialize();

    expect(updaterCheckMock).toHaveBeenCalledTimes(1);
    expect(useAppUpdateStore.getState().hasInitialized).toBe(true);
    expect(useAppUpdateStore.getState().state).toBe("idle");
  });

  it("downloads, installs, and restarts the app", async () => {
    updaterCheckMock.mockResolvedValue(makeUpdate());
    updaterDownloadAndInstallMock.mockImplementation(
      async (_updateId, onEvent) => {
        onEvent?.({
          event: "Started",
          data: { contentLength: 100 },
        });
        onEvent?.({
          event: "Progress",
          data: { chunkLength: 60 },
        });
        onEvent?.({
          event: "Progress",
          data: { chunkLength: 40 },
        });
        onEvent?.({
          event: "Finished",
        });
      },
    );

    await useAppUpdateStore.getState().initialize();
    await useAppUpdateStore.getState().install();

    expect(useAppUpdateStore.getState().downloadedBytes).toBe(100);
    expect(mockedBridge.restartApp).toHaveBeenCalledTimes(1);
    expect(updaterDownloadAndInstallMock).toHaveBeenCalledWith(
      "offer-1",
      expect.any(Function),
    );
    expect(updaterCloseMock).toHaveBeenCalledWith("offer-1");
  });

  it("opens the release page for the pending update", async () => {
    updaterCheckMock.mockResolvedValue(makeUpdate());

    await useAppUpdateStore.getState().initialize();
    await useAppUpdateStore.getState().viewChanges();

    expect(openExternalMock).toHaveBeenCalledWith(
      "https://github.com/paul-bouzian/Skein/releases/tag/v0.2.0",
    );
  });

  it("hides the toast without dropping the pending update", async () => {
    updaterCheckMock.mockResolvedValue(makeUpdate());

    await useAppUpdateStore.getState().initialize();
    useAppUpdateStore.getState().dismiss();

    expect(useAppUpdateStore.getState().state).toBe("available");
    expect(useAppUpdateStore.getState().snapshot?.availableVersion).toBe("0.2.0");
    expect(useAppUpdateStore.getState().noticeVisible).toBe(false);
  });
});
