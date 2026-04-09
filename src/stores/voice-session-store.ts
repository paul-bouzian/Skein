import { create } from "zustand";

import type { WorkspaceSnapshot } from "../lib/types";
import { transcribeEnvironmentVoice } from "../lib/bridge";
import { findThreadInWorkspace } from "./workspace-store";
import { useVoiceStatusStore } from "./voice-status-store";
import {
  MAX_RECORDING_DURATION_MS,
  startVoiceCapture,
} from "../directions/studio/composer/composer-voice-audio";

type ActiveVoiceCapture = Awaited<ReturnType<typeof startVoiceCapture>>;

export type VoiceSessionPhase =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing";

export type PendingVoiceOutcome =
  | {
      id: number;
      kind: "error";
      message: string;
      threadId: string;
    }
  | {
      id: number;
      kind: "transcript";
      text: string;
      threadId: string;
    };

type StartVoiceSessionInput = {
  environmentId: string;
  threadId: string;
};

type VoiceSessionState = {
  activeSessionToken: number | null;
  durationMs: number;
  ownerEnvironmentId: string | null;
  ownerThreadId: string | null;
  pendingOutcomesByThreadId: Record<string, PendingVoiceOutcome | undefined>;
  phase: VoiceSessionPhase;
  recordingStartedAt: number | null;

  clearPendingOutcome: (threadId: string, outcomeId?: number) => void;
  reconcileWorkspaceSnapshot: (snapshot: WorkspaceSnapshot | null) => Promise<void>;
  resetSession: () => Promise<void>;
  startSession: (input: StartVoiceSessionInput) => Promise<void>;
  stopSession: () => Promise<void>;
};

type VoiceSessionSet = (
  updater: (state: VoiceSessionState) => Partial<VoiceSessionState>,
) => void;

const INITIAL_STATE = {
  activeSessionToken: null,
  durationMs: 0,
  ownerEnvironmentId: null,
  ownerThreadId: null,
  pendingOutcomesByThreadId: {},
  phase: "idle" as const,
  recordingStartedAt: null,
};

let activeCapture: ActiveVoiceCapture | null = null;
let durationIntervalId: number | null = null;
let nextOutcomeId = 0;
let nextSessionToken = 0;

export const useVoiceSessionStore = create<VoiceSessionState>((set, get) => ({
  ...INITIAL_STATE,

  clearPendingOutcome: (threadId, outcomeId) => {
    set((state) => {
      const pendingOutcome = state.pendingOutcomesByThreadId[threadId];
      if (!pendingOutcome) {
        return {};
      }
      if (outcomeId !== undefined && pendingOutcome.id !== outcomeId) {
        return {};
      }

      const nextPendingOutcomes = { ...state.pendingOutcomesByThreadId };
      delete nextPendingOutcomes[threadId];
      if (
        state.phase === "idle" &&
        state.ownerThreadId === threadId &&
        nextPendingOutcomes[threadId] === undefined
      ) {
        return {
          durationMs: 0,
          ownerEnvironmentId: null,
          ownerThreadId: null,
          pendingOutcomesByThreadId: nextPendingOutcomes,
        };
      }

      return { pendingOutcomesByThreadId: nextPendingOutcomes };
    });
  },

  reconcileWorkspaceSnapshot: async (snapshot) => {
    const { ownerThreadId } = get();
    if (!snapshot || !ownerThreadId) {
      return;
    }
    if (findThreadInWorkspace(snapshot, ownerThreadId)) {
      return;
    }
    await get().resetSession();
  },

  resetSession: async () => {
    await cancelActiveCapture();
    clearDurationInterval();
    set(() => ({ ...INITIAL_STATE }));
  },

  startSession: async ({ environmentId, threadId }) => {
    const state = get();
    if (state.phase !== "idle" || selectOwnerPendingVoiceOutcome(state)) {
      return;
    }

    const sessionToken = nextSessionToken + 1;
    nextSessionToken = sessionToken;
    setVoiceSessionStarting(set, environmentId, threadId, sessionToken);

    try {
      const capture = await startVoiceCapture();
      if (get().activeSessionToken !== sessionToken) {
        await capture.cancel();
        return;
      }

      activeCapture = capture;
      const startedAt = performance.now();
      setVoiceSessionRecording(set, startedAt);
      startDurationInterval(get, set, sessionToken);
    } catch (cause: unknown) {
      if (get().activeSessionToken !== sessionToken) {
        return;
      }
      setVoiceSessionPendingOutcome(set, {
        durationMs: 0,
        ownerEnvironmentId: environmentId,
        ownerThreadId: threadId,
        outcome: buildErrorOutcome(readVoiceErrorMessage(cause)),
      });
    }
  },

  stopSession: async () => {
    const state = get();
    if (state.phase === "starting") {
      setVoiceSessionIdle(set);
      return;
    }
    if (
      state.phase !== "recording" ||
      !activeCapture ||
      !state.ownerEnvironmentId ||
      !state.ownerThreadId ||
      state.activeSessionToken === null
    ) {
      return;
    }

    const { activeSessionToken, ownerEnvironmentId, ownerThreadId } = state;
    const capture = activeCapture;
    activeCapture = null;
    clearDurationInterval();
    setVoiceSessionTranscribing(set);

    try {
      const clip = await capture.stop();
      if (get().activeSessionToken !== activeSessionToken) {
        return;
      }

      setVoiceSessionDuration(set, clip.durationMs);
      const result = await transcribeEnvironmentVoice({
        environmentId: ownerEnvironmentId,
        audioBase64: clip.audioBase64,
        durationMs: clip.durationMs,
        mimeType: clip.mimeType,
        sampleRateHz: clip.sampleRateHz,
      });

      if (get().activeSessionToken !== activeSessionToken) {
        return;
      }

      setVoiceSessionPendingOutcome(set, {
        durationMs: clip.durationMs,
        ownerEnvironmentId,
        ownerThreadId,
        outcome: buildTranscriptOutcome(result.text),
      });
    } catch (cause: unknown) {
      if (get().activeSessionToken !== activeSessionToken) {
        return;
      }

      setVoiceSessionPendingOutcome(set, {
        durationMs: get().durationMs,
        ownerEnvironmentId,
        ownerThreadId,
        outcome: buildErrorOutcome(readVoiceErrorMessage(cause)),
      });
      void useVoiceStatusStore
        .getState()
        .refreshEnvironmentVoiceStatus(ownerEnvironmentId);
    }
  },
}));

export function selectOwnerPendingVoiceOutcome(state: VoiceSessionState) {
  return state.ownerThreadId
    ? state.pendingOutcomesByThreadId[state.ownerThreadId] ?? null
    : null;
}

function buildErrorOutcome(message: string): PendingVoiceOutcome {
  return {
    id: nextVoiceOutcomeId(),
    kind: "error",
    message,
    threadId: "",
  };
}

function buildTranscriptOutcome(text: string): PendingVoiceOutcome {
  return {
    id: nextVoiceOutcomeId(),
    kind: "transcript",
    text,
    threadId: "",
  };
}

async function cancelActiveCapture() {
  const capture = activeCapture;
  activeCapture = null;
  if (!capture) {
    return;
  }
  try {
    await capture.cancel();
  } catch {
    // Ignore teardown failures while resetting the voice session.
  }
}

function clearDurationInterval() {
  if (durationIntervalId !== null) {
    window.clearInterval(durationIntervalId);
    durationIntervalId = null;
  }
}

function nextVoiceOutcomeId() {
  nextOutcomeId += 1;
  return nextOutcomeId;
}

function setVoiceSessionPendingOutcome(
  set: VoiceSessionSet,
  {
    durationMs,
    ownerEnvironmentId,
    ownerThreadId,
    outcome,
  }: {
    durationMs: number;
    ownerEnvironmentId: string;
    ownerThreadId: string;
    outcome: PendingVoiceOutcome;
  },
) {
  clearDurationInterval();
  set((state) => ({
    activeSessionToken: null,
    durationMs,
    ownerEnvironmentId,
    ownerThreadId,
    pendingOutcomesByThreadId: {
      ...state.pendingOutcomesByThreadId,
      [ownerThreadId]: { ...outcome, threadId: ownerThreadId },
    },
    phase: "idle",
    recordingStartedAt: null,
  }));
}

function setVoiceSessionDuration(set: VoiceSessionSet, durationMs: number) {
  set(() => ({ durationMs }));
}

function setVoiceSessionIdle(set: VoiceSessionSet) {
  clearDurationInterval();
  set(() => ({
    activeSessionToken: null,
    durationMs: 0,
    ownerEnvironmentId: null,
    ownerThreadId: null,
    phase: "idle",
    recordingStartedAt: null,
  }));
}

function setVoiceSessionRecording(
  set: VoiceSessionSet,
  recordingStartedAt: number,
) {
  set(() => ({
    durationMs: 0,
    phase: "recording",
    recordingStartedAt,
  }));
}

function setVoiceSessionStarting(
  set: VoiceSessionSet,
  environmentId: string,
  threadId: string,
  sessionToken: number,
) {
  set((state) => {
    const nextPendingOutcomes = { ...state.pendingOutcomesByThreadId };
    delete nextPendingOutcomes[threadId];
    return {
      activeSessionToken: sessionToken,
      durationMs: 0,
      ownerEnvironmentId: environmentId,
      ownerThreadId: threadId,
      pendingOutcomesByThreadId: nextPendingOutcomes,
      phase: "starting",
      recordingStartedAt: null,
    };
  });
}

function setVoiceSessionTranscribing(set: VoiceSessionSet) {
  set((state) => ({
    durationMs:
      state.recordingStartedAt === null
        ? state.durationMs
        : Math.max(0, performance.now() - state.recordingStartedAt),
    phase: "transcribing",
    recordingStartedAt: null,
  }));
}

function startDurationInterval(
  get: () => VoiceSessionState,
  set: VoiceSessionSet,
  sessionToken: number,
) {
  clearDurationInterval();
  durationIntervalId = window.setInterval(() => {
    const state = get();
    if (
      state.activeSessionToken !== sessionToken ||
      state.phase !== "recording" ||
      state.recordingStartedAt === null
    ) {
      clearDurationInterval();
      return;
    }

    const durationMs = Math.max(
      0,
      performance.now() - state.recordingStartedAt,
    );
    setVoiceSessionDuration(set, durationMs);
    if (durationMs >= MAX_RECORDING_DURATION_MS) {
      clearDurationInterval();
      void get().stopSession();
    }
  }, 100);
}

function readVoiceErrorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Voice transcription failed.";
}

export async function resetVoiceSessionStore() {
  await useVoiceSessionStore.getState().resetSession();
}
