import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";

import { transcribeEnvironmentVoice } from "../../../lib/bridge";
import { useVoiceStatusStore } from "../../../stores/voice-status-store";
import {
  MAX_RECORDING_DURATION_MS,
  startVoiceCapture,
} from "./composer-voice-audio";

type Props = {
  currentDraft: string;
  environmentId: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  locked: boolean;
  onChangeDraft: (value: string) => void;
  sessionKey: string;
};

type ActiveVoiceCapture = Awaited<ReturnType<typeof startVoiceCapture>>;

export function useComposerVoiceInput({
  currentDraft,
  environmentId,
  inputRef,
  locked,
  onChangeDraft,
  sessionKey,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureRef = useRef<ActiveVoiceCapture | null>(null);
  const currentDraftRef = useRef(currentDraft);
  const mountedRef = useRef(true);
  const sessionEpochRef = useRef(0);
  const [phase, setPhase] = useState<
    "idle" | "starting" | "recording" | "transcribing"
  >("idle");
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(
    null,
  );
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const [transcribingDurationMs, setTranscribingDurationMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const snapshot = useVoiceStatusStore(
    (state) => state.snapshotsByEnvironmentId[environmentId] ?? null,
  );
  const loading = useVoiceStatusStore(
    (state) => state.loadingByEnvironmentId[environmentId] ?? false,
  );
  const storeError = useVoiceStatusStore(
    (state) => state.errorByEnvironmentId[environmentId] ?? null,
  );
  const ensureEnvironmentVoiceStatus = useVoiceStatusStore(
    (state) => state.ensureEnvironmentVoiceStatus,
  );
  const refreshEnvironmentVoiceStatus = useVoiceStatusStore(
    (state) => state.refreshEnvironmentVoiceStatus,
  );

  const browserSupported =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window !== "undefined" &&
    (typeof window.AudioContext !== "undefined" ||
      typeof (window as Window & { webkitAudioContext?: unknown })
        .webkitAudioContext !== "undefined");
  const voiceAvailable = browserSupported && snapshot?.available === true;
  const availabilityMessage = useMemo(() => {
    if (!browserSupported) {
      return "Microphone capture is not available in this desktop runtime.";
    }
    return (
      snapshot?.message ??
      storeError ??
      "Voice transcription is unavailable right now."
    );
  }, [browserSupported, snapshot?.message, storeError]);

  useEffect(() => {
    currentDraftRef.current = currentDraft;
  }, [currentDraft]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void ensureEnvironmentVoiceStatus(environmentId);
  }, [ensureEnvironmentVoiceStatus, environmentId]);

  useEffect(() => {
    function handleWindowFocus() {
      void refreshEnvironmentVoiceStatus(environmentId);
    }

    window.addEventListener("focus", handleWindowFocus);
    return () => {
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [environmentId, refreshEnvironmentVoiceStatus]);

  useEffect(() => {
    return () => {
      void cleanupActiveCapture(captureRef);
    };
  }, []);

  useEffect(() => {
    sessionEpochRef.current += 1;
    setPhase("idle");
    setErrorMessage(null);
    setRecordingDurationMs(0);
    setTranscribingDurationMs(0);
    setRecordingStartedAt(null);
    void cleanupActiveCapture(captureRef);
  }, [sessionKey]);

  useEffect(() => {
    if (phase !== "recording" || recordingStartedAt === null) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRecordingDurationMs(
        Math.max(0, performance.now() - recordingStartedAt),
      );
    }, 100);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [phase, recordingStartedAt]);

  useEffect(() => {
    if (phase !== "recording") {
      return;
    }

    let frameId = 0;
    const renderFrame = () => {
      captureRef.current?.drawSpectrum(canvasRef.current);
      frameId = window.requestAnimationFrame(renderFrame);
    };

    frameId = window.requestAnimationFrame(renderFrame);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [phase]);

  const stopRecording = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) {
      return;
    }
    const sessionEpoch = sessionEpochRef.current;

    captureRef.current = null;
    setPhase("transcribing");
    setTranscribingDurationMs(recordingDurationMs);

    try {
      const clip = await capture.stop();
      if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) {
        return;
      }

      setTranscribingDurationMs(clip.durationMs);
      const result = await transcribeEnvironmentVoice({
        environmentId,
        audioBase64: clip.audioBase64,
        durationMs: clip.durationMs,
        mimeType: clip.mimeType,
        sampleRateHz: clip.sampleRateHz,
      });

      if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) {
        return;
      }

      setPhase("idle");
      setRecordingDurationMs(0);
      setRecordingStartedAt(null);
      setTranscribingDurationMs(0);
      setErrorMessage(null);
      onChangeDraft(appendVoiceTranscript(currentDraftRef.current, result.text));
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    } catch (cause: unknown) {
      if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) {
        return;
      }
      setPhase("idle");
      setRecordingStartedAt(null);
      setRecordingDurationMs(0);
      setTranscribingDurationMs(0);
      setErrorMessage(readVoiceErrorMessage(cause));
      void refreshEnvironmentVoiceStatus(environmentId);
    }
  }, [
    environmentId,
    inputRef,
    onChangeDraft,
    recordingDurationMs,
    refreshEnvironmentVoiceStatus,
  ]);

  useEffect(() => {
    if (
      phase === "recording" &&
      recordingDurationMs >= MAX_RECORDING_DURATION_MS
    ) {
      void stopRecording();
    }
  }, [phase, recordingDurationMs, stopRecording]);

  const startRecording = useCallback(async () => {
    if (phase !== "idle" || locked || loading || !voiceAvailable) {
      return;
    }
    const sessionEpoch = sessionEpochRef.current;

    setErrorMessage(null);
    setRecordingDurationMs(0);
    setTranscribingDurationMs(0);

    try {
      setPhase("starting");
      captureRef.current = await startVoiceCapture();
      if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) {
        await cleanupActiveCapture(captureRef);
        return;
      }

      const startedAt = performance.now();
      setRecordingStartedAt(startedAt);
      setPhase("recording");
    } catch (cause: unknown) {
      if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) {
        return;
      }
      setErrorMessage(readVoiceErrorMessage(cause));
      setRecordingStartedAt(null);
      setPhase("idle");
    }
  }, [loading, locked, phase, voiceAvailable]);

  const buttonDisabled =
    phase === "starting" ||
    phase === "transcribing" ||
    (phase === "idle" && (locked || loading || !voiceAvailable));
  const buttonLabel =
    phase === "recording"
      ? "Stop voice dictation"
      : phase === "starting"
        ? "Starting voice dictation"
        : phase === "transcribing"
          ? "Transcribing voice dictation"
        : "Start voice dictation";
  const buttonTitle =
    phase === "recording"
      ? "Stop recording and transcribe"
      : phase === "starting"
        ? "Starting microphone capture"
        : phase === "transcribing"
          ? "Transcribing voice recording"
          : locked
            ? "Voice dictation is unavailable while the composer is locked"
            : loading && browserSupported
              ? "Checking voice transcription availability"
              : voiceAvailable
                ? "Record a voice message"
                : availabilityMessage;

  return {
    buttonDisabled,
    buttonLabel,
    buttonTitle,
    canvasRef,
    errorMessage,
    isRecording: phase === "recording",
    isTranscribing: phase === "transcribing",
    onDismissError: () => setErrorMessage(null),
    onVoiceButtonClick: () => {
      if (phase === "recording") {
        void stopRecording();
        return;
      }
      void startRecording();
    },
    voiceBusy: phase !== "idle",
    voiceDurationMs:
      phase === "recording" ? recordingDurationMs : transcribingDurationMs,
  };
}

async function cleanupActiveCapture(
  captureRef: MutableRefObject<ActiveVoiceCapture | null>,
) {
  const capture = captureRef.current;
  captureRef.current = null;
  if (!capture) {
    return;
  }
  try {
    await capture.cancel();
  } catch {
    // Ignore teardown failures during unmounts and session switches.
  }
}

function appendVoiceTranscript(currentDraft: string, transcript: string) {
  const trimmedTranscript = transcript.trim();
  if (trimmedTranscript.length === 0) {
    return currentDraft;
  }
  if (currentDraft.trim().length === 0) {
    return trimmedTranscript;
  }
  return /\s$/.test(currentDraft)
    ? `${currentDraft}${trimmedTranscript}`
    : `${currentDraft} ${trimmedTranscript}`;
}

function readVoiceErrorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Voice transcription failed.";
}

export { appendVoiceTranscript };
