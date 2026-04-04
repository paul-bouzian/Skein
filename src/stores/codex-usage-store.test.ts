import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import type { CodexUsageEventPayload } from "../lib/types";
import { teardownCodexUsageListener, useCodexUsageStore } from "./codex-usage-store";

vi.mock("../lib/bridge", () => ({
  getEnvironmentCodexRateLimits: vi.fn(),
  listenToCodexUsageEvents: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  teardownCodexUsageListener();
  useCodexUsageStore.setState((state) => ({
    ...state,
    snapshotsByEnvironmentId: {},
    loadingByEnvironmentId: {},
    errorByEnvironmentId: {},
    lastFetchedAtByEnvironmentId: {},
    listenerReady: false,
  }));
});

describe("codex usage store", () => {
  it("loads usage for the selected environment", async () => {
    mockedBridge.getEnvironmentCodexRateLimits.mockResolvedValue({
      primary: {
        usedPercent: 18,
        windowDurationMins: 300,
        resetsAt: 1_775_306_400,
      },
      secondary: {
        usedPercent: 55,
        windowDurationMins: 10_080,
        resetsAt: 1_775_910_400,
      },
    });

    await useCodexUsageStore.getState().ensureEnvironmentUsage("env-1");

    expect(mockedBridge.getEnvironmentCodexRateLimits).toHaveBeenCalledWith("env-1");
    expect(useCodexUsageStore.getState().snapshotsByEnvironmentId["env-1"]?.primary?.usedPercent).toBe(
      18,
    );
  });

  it("reuses fresh cached usage instead of refetching", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T10:00:00Z"));
    mockedBridge.getEnvironmentCodexRateLimits.mockResolvedValue({
      primary: { usedPercent: 11 },
      secondary: { usedPercent: 44 },
    });

    await useCodexUsageStore.getState().ensureEnvironmentUsage("env-1");
    await useCodexUsageStore.getState().ensureEnvironmentUsage("env-1");

    expect(mockedBridge.getEnvironmentCodexRateLimits).toHaveBeenCalledTimes(1);
  });

  it("does not cache failed usage fetches as fresh snapshots", async () => {
    mockedBridge.getEnvironmentCodexRateLimits
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        primary: { usedPercent: 21 },
        secondary: { usedPercent: 48 },
      });

    await useCodexUsageStore.getState().ensureEnvironmentUsage("env-1");
    expect(useCodexUsageStore.getState().lastFetchedAtByEnvironmentId["env-1"]).toBeNull();

    await useCodexUsageStore.getState().ensureEnvironmentUsage("env-1");

    expect(mockedBridge.getEnvironmentCodexRateLimits).toHaveBeenCalledTimes(2);
    expect(useCodexUsageStore.getState().snapshotsByEnvironmentId["env-1"]?.primary?.usedPercent).toBe(
      21,
    );
  });

  it("applies live usage updates from the runtime event stream", async () => {
    let callback: ((payload: CodexUsageEventPayload) => void) | null = null;
    mockedBridge.listenToCodexUsageEvents.mockImplementation(async (handler) => {
      callback = handler;
      return () => undefined;
    });

    await useCodexUsageStore.getState().initializeListener();
    expect(callback).not.toBeNull();
    callback!({
      environmentId: "env-1",
      rateLimits: {
        primary: { usedPercent: 72 },
      },
    });

    expect(useCodexUsageStore.getState().snapshotsByEnvironmentId["env-1"]?.primary?.usedPercent).toBe(
      72,
    );
    expect(useCodexUsageStore.getState().loadingByEnvironmentId["env-1"]).toBe(false);
  });

  it("ignores stale fetch responses after a newer live update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T10:00:00Z"));

    const deferred = deferredPromise<{
      primary: { usedPercent: number };
    }>();
    let callback: ((payload: CodexUsageEventPayload) => void) | null = null;

    mockedBridge.getEnvironmentCodexRateLimits.mockReturnValue(deferred.promise);
    mockedBridge.listenToCodexUsageEvents.mockImplementation(async (handler) => {
      callback = handler;
      return () => undefined;
    });

    await useCodexUsageStore.getState().initializeListener();

    const refreshPromise = useCodexUsageStore
      .getState()
      .refreshEnvironmentUsage("env-1");

    vi.setSystemTime(new Date("2026-04-04T10:00:01Z"));
    callback!({
      environmentId: "env-1",
      rateLimits: {
        primary: { usedPercent: 72, windowDurationMins: 300 },
        secondary: { usedPercent: 44, windowDurationMins: 10_080 },
      },
    });

    deferred.resolve({
      primary: { usedPercent: 18 },
    });
    await refreshPromise;

    const snapshot = useCodexUsageStore.getState().snapshotsByEnvironmentId["env-1"];
    expect(snapshot?.primary?.usedPercent).toBe(72);
    expect(snapshot?.secondary?.usedPercent).toBe(44);
  });

  it("ignores stale fetch failures after a newer live update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T10:00:00Z"));

    const deferred = deferredPromise<never>();
    let callback: ((payload: CodexUsageEventPayload) => void) | null = null;

    mockedBridge.getEnvironmentCodexRateLimits.mockReturnValue(deferred.promise);
    mockedBridge.listenToCodexUsageEvents.mockImplementation(async (handler) => {
      callback = handler;
      return () => undefined;
    });

    await useCodexUsageStore.getState().initializeListener();

    const refreshPromise = useCodexUsageStore
      .getState()
      .refreshEnvironmentUsage("env-1");

    vi.setSystemTime(new Date("2026-04-04T10:00:01Z"));
    callback!({
      environmentId: "env-1",
      rateLimits: {
        primary: { usedPercent: 72, windowDurationMins: 300 },
        secondary: { usedPercent: 44, windowDurationMins: 10_080 },
      },
    });

    deferred.reject(new Error("temporary failure"));
    await refreshPromise;

    const state = useCodexUsageStore.getState();
    expect(state.snapshotsByEnvironmentId["env-1"]?.primary?.usedPercent).toBe(72);
    expect(state.errorByEnvironmentId["env-1"]).toBeNull();
    expect(state.lastFetchedAtByEnvironmentId["env-1"]).toBe(
      new Date("2026-04-04T10:00:01Z").valueOf(),
    );
  });

  it("merges partial live usage updates into the existing snapshot", async () => {
    let callback: ((payload: CodexUsageEventPayload) => void) | null = null;
    mockedBridge.listenToCodexUsageEvents.mockImplementation(async (handler) => {
      callback = handler;
      return () => undefined;
    });
    mockedBridge.getEnvironmentCodexRateLimits.mockResolvedValue({
      planType: "pro",
      primary: {
        usedPercent: 18,
        windowDurationMins: 300,
        resetsAt: 1_775_306_400,
      },
      secondary: {
        usedPercent: 55,
        windowDurationMins: 10_080,
        resetsAt: 1_775_910_400,
      },
    });

    await useCodexUsageStore.getState().initializeListener();
    await useCodexUsageStore.getState().ensureEnvironmentUsage("env-1");

    callback!({
      environmentId: "env-1",
      rateLimits: {
        primary: {
          usedPercent: 72,
        },
      },
    });

    const snapshot = useCodexUsageStore.getState().snapshotsByEnvironmentId["env-1"];
    expect(snapshot?.planType).toBe("pro");
    expect(snapshot?.primary).toEqual({
      usedPercent: 72,
      windowDurationMins: 300,
      resetsAt: 1_775_306_400,
    });
    expect(snapshot?.secondary).toEqual({
      usedPercent: 55,
      windowDurationMins: 10_080,
      resetsAt: 1_775_910_400,
    });
  });
});
