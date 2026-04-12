import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import {
  makeEnvironment,
  makeProject,
  makeWorkspaceSnapshot,
} from "../test/fixtures/conversation";
import { useVoiceStatusStore } from "./voice-status-store";
import { useWorkspaceStore } from "./workspace-store";

vi.mock("../lib/bridge", () => ({
  getEnvironmentVoiceStatus: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: makeWorkspaceSnapshot({
      projects: [
        makeProject({
          environments: [makeEnvironment({ id: "env-1" })],
        }),
      ],
    }),
  }));
  useVoiceStatusStore.setState((state) => ({
    ...state,
    snapshotsByEnvironmentId: {},
    loadingByEnvironmentId: {},
    errorByEnvironmentId: {},
    lastFetchedAtByEnvironmentId: {},
    lastRequestedAtByEnvironmentId: {},
  }));
});

describe("voice status store", () => {
  it("loads voice status for an environment", async () => {
    mockedBridge.getEnvironmentVoiceStatus.mockResolvedValue({
      environmentId: "env-1",
      available: true,
      authMode: "chatgpt",
      unavailableReason: null,
      message: null,
    });

    await useVoiceStatusStore.getState().ensureEnvironmentVoiceStatus("env-1");

    expect(mockedBridge.getEnvironmentVoiceStatus).toHaveBeenCalledWith(
      "env-1",
    );
    expect(
      useVoiceStatusStore.getState().snapshotsByEnvironmentId["env-1"]
        ?.available,
    ).toBe(true);
  });

  it("reuses a fresh cached voice status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T10:00:00Z"));
    mockedBridge.getEnvironmentVoiceStatus.mockResolvedValue({
      environmentId: "env-1",
      available: false,
      authMode: "apiKey",
      unavailableReason: "chatgptRequired",
      message: "Voice transcription requires Sign in with ChatGPT.",
    });

    await useVoiceStatusStore.getState().ensureEnvironmentVoiceStatus("env-1");
    await useVoiceStatusStore.getState().ensureEnvironmentVoiceStatus("env-1");

    expect(mockedBridge.getEnvironmentVoiceStatus).toHaveBeenCalledTimes(1);
  });

  it("does not cache failed voice status fetches as fresh", async () => {
    mockedBridge.getEnvironmentVoiceStatus
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        environmentId: "env-1",
        available: true,
        authMode: "chatgpt",
        unavailableReason: null,
        message: null,
      });

    await useVoiceStatusStore.getState().ensureEnvironmentVoiceStatus("env-1");
    expect(
      useVoiceStatusStore.getState().lastFetchedAtByEnvironmentId["env-1"],
    ).toBeNull();

    await useVoiceStatusStore.getState().ensureEnvironmentVoiceStatus("env-1");

    expect(mockedBridge.getEnvironmentVoiceStatus).toHaveBeenCalledTimes(2);
    expect(
      useVoiceStatusStore.getState().snapshotsByEnvironmentId["env-1"]
        ?.available,
    ).toBe(true);
  });

  it("deduplicates concurrent refreshes for the same environment", async () => {
    const deferred =
      createDeferred<
        Awaited<ReturnType<typeof bridge.getEnvironmentVoiceStatus>>
      >();
    mockedBridge.getEnvironmentVoiceStatus.mockReturnValue(deferred.promise);

    const firstRefresh = useVoiceStatusStore
      .getState()
      .refreshEnvironmentVoiceStatus("env-1");
    const secondRefresh = useVoiceStatusStore
      .getState()
      .refreshEnvironmentVoiceStatus("env-1");

    expect(mockedBridge.getEnvironmentVoiceStatus).toHaveBeenCalledTimes(1);

    deferred.resolve({
      environmentId: "env-1",
      available: true,
      authMode: "chatgpt",
      unavailableReason: null,
      message: null,
    });

    await firstRefresh;
    await secondRefresh;
  });

  it("clears stale availability when a refresh fails", async () => {
    useVoiceStatusStore.setState((state) => ({
      ...state,
      snapshotsByEnvironmentId: {
        ...state.snapshotsByEnvironmentId,
        "env-1": {
          environmentId: "env-1",
          available: true,
          authMode: "chatgpt",
          unavailableReason: null,
          message: null,
        },
      },
    }));
    mockedBridge.getEnvironmentVoiceStatus.mockRejectedValue(
      new Error("temporary failure"),
    );

    await useVoiceStatusStore.getState().refreshEnvironmentVoiceStatus("env-1");

    const state = useVoiceStatusStore.getState();
    expect(state.snapshotsByEnvironmentId["env-1"]).toBeNull();
    expect(state.errorByEnvironmentId["env-1"]).toBe("temporary failure");
  });

  it("still reads voice status for stopped runtimes through the backend", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [
              makeEnvironment({
                id: "env-1",
                runtime: {
                  environmentId: "env-1",
                  state: "stopped",
                },
              }),
            ],
          }),
        ],
      }),
    }));
    mockedBridge.getEnvironmentVoiceStatus.mockResolvedValue({
      environmentId: "env-1",
      available: false,
      authMode: null,
      unavailableReason: "runtimeUnavailable",
      message: "Voice transcription is unavailable right now.",
    });

    await useVoiceStatusStore.getState().ensureEnvironmentVoiceStatus("env-1");

    expect(mockedBridge.getEnvironmentVoiceStatus).toHaveBeenCalledWith("env-1");
  });
});

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
