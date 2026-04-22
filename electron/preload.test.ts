import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SkeinDesktopApi } from "../src/lib/desktop-types.js";

let exposedApi: SkeinDesktopApi | null = null;

const invokeMock = vi.fn();
const onMock = vi.fn();
const removeListenerMock = vi.fn();
const getPathForFileMock = vi.fn();

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
}

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn(
      (_name: string, api: SkeinDesktopApi) => (exposedApi = api),
    ),
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    on: (...args: unknown[]) => onMock(...args),
    removeListener: (...args: unknown[]) => removeListenerMock(...args),
  },
  webUtils: {
    getPathForFile: (...args: unknown[]) => getPathForFileMock(...args),
  },
}));

async function loadPreload() {
  await import("./preload.js");
  if (!exposedApi) {
    throw new Error("Expected preload to expose skeinDesktop");
  }
  return exposedApi;
}

describe("preload preferences", () => {
  beforeEach(() => {
    vi.resetModules();
    exposedApi = null;
    invokeMock.mockReset();
    onMock.mockReset();
    removeListenerMock.mockReset();
    getPathForFileMock.mockReset();
    process.argv = [
      "node",
      "electron/preload.js",
      `--skein-ui-prefs=${Buffer.from(
        JSON.stringify({ "skein.theme": "dark" }),
      ).toString("base64")}`,
    ];
  });

  it("serializes concurrent preference writes so stale rollbacks do not win", async () => {
    const firstWrite = createDeferred<void>();
    const secondWrite = createDeferred<void>();
    invokeMock
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);

    const api = await loadPreload();
    const preferences = api.preferences;
    if (!preferences) {
      throw new Error("Expected preload to expose preferences");
    }

    const firstSet = preferences.set("skein.theme", "light");
    const secondSet = preferences.set("skein.theme", "system");

    await flushMicrotasks();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(preferences.getSnapshot()).toEqual({
      "skein.theme": "light",
    });

    firstWrite.reject(new Error("disk full"));
    await expect(firstSet).rejects.toThrow("disk full");

    await flushMicrotasks();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(preferences.getSnapshot()).toEqual({
      "skein.theme": "system",
    });

    secondWrite.resolve(undefined);
    await expect(secondSet).resolves.toBeUndefined();
    expect(preferences.getSnapshot()).toEqual({
      "skein.theme": "system",
    });
  });
});
