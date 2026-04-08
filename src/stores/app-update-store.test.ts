import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import { useAppUpdateStore } from "./app-update-store";

const checkMock = vi.fn();
const openUrlMock = vi.fn();
const closeMock = vi.fn().mockResolvedValue(undefined);
const downloadAndInstallMock = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => checkMock(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

vi.mock("../lib/bridge", () => ({
  restartApp: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);

function makeUpdate(overrides?: Partial<Record<string, unknown>>) {
  return {
    currentVersion: "0.1.0",
    version: "0.2.0",
    date: "2026-04-04T10:00:00Z",
    body: "Adds native updater support.",
    downloadAndInstall: downloadAndInstallMock,
    close: closeMock,
    ...overrides,
  };
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
  });
});

describe("app-update-store", () => {
  it("exposes a pending release after a successful check", async () => {
    checkMock.mockResolvedValue(makeUpdate());

    await useAppUpdateStore.getState().initialize();

    expect(useAppUpdateStore.getState().state).toBe("available");
    expect(useAppUpdateStore.getState().snapshot?.releaseUrl).toBe(
      "https://github.com/paul-bouzian/Loom/releases/tag/v0.2.0",
    );
  });

  it("downloads, installs, and restarts the app", async () => {
    checkMock.mockResolvedValue(
      makeUpdate({
        downloadAndInstall: (onEvent?: (event: unknown) => void) => {
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
          return Promise.resolve();
        },
      }),
    );

    await useAppUpdateStore.getState().initialize();
    await useAppUpdateStore.getState().install();

    expect(useAppUpdateStore.getState().downloadedBytes).toBe(100);
    expect(mockedBridge.restartApp).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("opens the release page for the pending update", async () => {
    checkMock.mockResolvedValue(makeUpdate());

    await useAppUpdateStore.getState().initialize();
    await useAppUpdateStore.getState().viewChanges();

    expect(openUrlMock).toHaveBeenCalledWith(
      "https://github.com/paul-bouzian/Loom/releases/tag/v0.2.0",
    );
  });
});
