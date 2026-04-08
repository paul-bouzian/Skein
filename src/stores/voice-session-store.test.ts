import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../lib/bridge";
import {
  makeEnvironment,
  makeProject,
  makeThread,
  makeWorkspaceSnapshot,
} from "../test/fixtures/conversation";
import {
  resetVoiceSessionStore,
  useVoiceSessionStore,
} from "./voice-session-store";
import { startVoiceCapture } from "../directions/studio/composer/composer-voice-audio";

vi.mock("../lib/bridge", () => ({
  transcribeEnvironmentVoice: vi.fn(),
}));

vi.mock("../directions/studio/composer/composer-voice-audio", () => ({
  MAX_RECORDING_DURATION_MS: 120_000,
  startVoiceCapture: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);
const mockedStartVoiceCapture = vi.mocked(startVoiceCapture);

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
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  await resetVoiceSessionStore();
  mockedBridge.transcribeEnvironmentVoice.mockReset();
  mockedStartVoiceCapture.mockReset();
});

afterEach(async () => {
  await resetVoiceSessionStore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("voice session store", () => {
  it("auto-stops at the max duration and stores the transcript for the owner thread", async () => {
    const capture = makeCapture();
    mockedStartVoiceCapture.mockResolvedValue(capture);
    mockedBridge.transcribeEnvironmentVoice.mockResolvedValue({
      text: "voice note",
    });

    await useVoiceSessionStore.getState().startSession({
      environmentId: "env-1",
      threadId: "thread-1",
    });

    expect(useVoiceSessionStore.getState().phase).toBe("recording");

    await vi.advanceTimersByTimeAsync(120_000);

    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(
      useVoiceSessionStore.getState().pendingOutcomesByThreadId["thread-1"],
    ).toMatchObject({
      kind: "transcript",
      text: "voice note",
      threadId: "thread-1",
    });
  });

  it("refuses to start a second session while one is already active", async () => {
    mockedStartVoiceCapture.mockResolvedValue(makeCapture());

    await useVoiceSessionStore.getState().startSession({
      environmentId: "env-1",
      threadId: "thread-1",
    });
    await useVoiceSessionStore.getState().startSession({
      environmentId: "env-2",
      threadId: "thread-2",
    });

    expect(mockedStartVoiceCapture).toHaveBeenCalledTimes(1);
    expect(useVoiceSessionStore.getState().ownerThreadId).toBe("thread-1");
  });

  it("keeps the current owner while a voice result is pending review", async () => {
    useVoiceSessionStore.setState((state) => ({
      ...state,
      durationMs: 1_200,
      ownerEnvironmentId: "env-1",
      ownerThreadId: "thread-1",
      pendingOutcomesByThreadId: {
        "thread-1": {
          id: 1,
          kind: "error",
          message: "Voice transcription failed.",
          threadId: "thread-1",
        },
      },
      phase: "idle",
    }));

    await useVoiceSessionStore.getState().startSession({
      environmentId: "env-2",
      threadId: "thread-2",
    });

    expect(mockedStartVoiceCapture).not.toHaveBeenCalled();
    expect(useVoiceSessionStore.getState()).toMatchObject({
      ownerEnvironmentId: "env-1",
      ownerThreadId: "thread-1",
      phase: "idle",
    });
  });

  it("cancels a session while microphone capture is still starting", async () => {
    const capture = makeCapture();
    const startCapture = createDeferred<typeof capture>();
    mockedStartVoiceCapture.mockReturnValue(startCapture.promise);

    const startSession = useVoiceSessionStore.getState().startSession({
      environmentId: "env-1",
      threadId: "thread-1",
    });

    expect(useVoiceSessionStore.getState().phase).toBe("starting");

    await useVoiceSessionStore.getState().stopSession();

    expect(useVoiceSessionStore.getState().phase).toBe("idle");

    startCapture.resolve(capture);
    await startSession;

    expect(capture.cancel).toHaveBeenCalledTimes(1);
    expect(useVoiceSessionStore.getState()).toMatchObject({
      activeSessionToken: null,
      ownerEnvironmentId: null,
      ownerThreadId: null,
      phase: "idle",
    });
  });

  it("resets the session when the owner thread disappears during recording", async () => {
    const capture = makeCapture();
    mockedStartVoiceCapture.mockResolvedValue(capture);

    await useVoiceSessionStore.getState().startSession({
      environmentId: "env-1",
      threadId: "thread-1",
    });

    await useVoiceSessionStore.getState().reconcileWorkspaceSnapshot(
      makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [
              makeEnvironment({
                id: "env-1",
                threads: [makeThread({ id: "thread-2", title: "Thread 2" })],
              }),
            ],
          }),
        ],
      }),
    );

    expect(capture.cancel).toHaveBeenCalledTimes(1);
    expect(useVoiceSessionStore.getState()).toMatchObject({
      activeSessionToken: null,
      ownerEnvironmentId: null,
      ownerThreadId: null,
      pendingOutcomesByThreadId: {},
      phase: "idle",
    });
  });

  it("drops an in-flight transcription if the owner thread disappears", async () => {
    const transcription = createDeferred<{ text: string }>();
    const capture = makeCapture();
    mockedStartVoiceCapture.mockResolvedValue(capture);
    mockedBridge.transcribeEnvironmentVoice.mockReturnValue(transcription.promise);

    await useVoiceSessionStore.getState().startSession({
      environmentId: "env-1",
      threadId: "thread-1",
    });

    const stopSession = useVoiceSessionStore.getState().stopSession();
    expect(useVoiceSessionStore.getState().phase).toBe("transcribing");

    await useVoiceSessionStore.getState().reconcileWorkspaceSnapshot(
      makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [
              makeEnvironment({
                id: "env-1",
                threads: [makeThread({ id: "thread-2", title: "Thread 2" })],
              }),
            ],
          }),
        ],
      }),
    );

    transcription.resolve({ text: "voice note" });
    await stopSession;

    expect(useVoiceSessionStore.getState()).toMatchObject({
      activeSessionToken: null,
      ownerEnvironmentId: null,
      ownerThreadId: null,
      pendingOutcomesByThreadId: {},
      phase: "idle",
    });
  });
});

function makeCapture() {
  return {
    cancel: vi.fn(async () => undefined),
    drawSpectrum: vi.fn(),
    stop: vi.fn(async () => ({
      audioBase64: "dGVzdA==",
      durationMs: 1_200,
      mimeType: "audio/wav" as const,
      sampleRateHz: 24_000 as const,
    })),
  };
}
