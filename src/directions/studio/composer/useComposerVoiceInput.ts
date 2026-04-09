import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";

import { useVoiceStatusStore } from "../../../stores/voice-status-store";
import {
  selectOwnerPendingVoiceOutcome,
  type PendingVoiceOutcome,
  useVoiceSessionStore,
} from "../../../stores/voice-session-store";
import {
  findThreadInWorkspace,
  useWorkspaceStore,
} from "../../../stores/workspace-store";

type Props = {
  currentDraft: string;
  environmentId: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  locked: boolean;
  onChangeDraft: (value: string) => void;
  threadId: string;
};

export function useComposerVoiceInput({
  currentDraft,
  environmentId,
  inputRef,
  locked,
  onChangeDraft,
  threadId,
}: Props) {
  const currentDraftRef = useRef(currentDraft);
  const handledOutcomeIdRef = useRef<number | null>(null);
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
  const phase = useVoiceSessionStore((state) => state.phase);
  const ownerThreadId = useVoiceSessionStore((state) => state.ownerThreadId);
  const durationMs = useVoiceSessionStore((state) => state.durationMs);
  const ownerPendingOutcome = useVoiceSessionStore(selectOwnerPendingVoiceOutcome);
  const pendingOutcome = useVoiceSessionStore(
    (state) => state.pendingOutcomesByThreadId[threadId] ?? null,
  );
  const clearPendingOutcome = useVoiceSessionStore(
    (state) => state.clearPendingOutcome,
  );
  const startSession = useVoiceSessionStore((state) => state.startSession);
  const stopSession = useVoiceSessionStore((state) => state.stopSession);
  const workspaceSnapshot = useWorkspaceStore((state) => state.snapshot);

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
  const ownerThreadTitle = useMemo(
    () => findThreadInWorkspace(workspaceSnapshot, ownerThreadId)?.thread.title ?? null,
    [ownerThreadId, workspaceSnapshot],
  );
  const ownsActiveSession =
    ownerThreadId !== null && ownerThreadId === threadId && phase !== "idle";
  const activeSessionElsewhere =
    ownerThreadId !== null && ownerThreadId !== threadId && phase !== "idle";
  const pendingOutcomeNeedsReview = phase === "idle" && pendingOutcome !== null;
  const pendingOutcomeElsewhere =
    ownerThreadId !== null &&
    ownerThreadId !== threadId &&
    phase === "idle" &&
    ownerPendingOutcome !== null;
  const isRecording = ownsActiveSession && phase === "recording";
  const isStarting = ownsActiveSession && phase === "starting";
  const isTranscribing = ownsActiveSession && phase === "transcribing";
  const voiceBusy = ownsActiveSession;
  const pendingError =
    pendingOutcome?.kind === "error" ? pendingOutcome.message : null;

  useEffect(() => {
    currentDraftRef.current = currentDraft;
  }, [currentDraft]);

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
    if (!pendingOutcome) {
      handledOutcomeIdRef.current = null;
      return;
    }
    if (
      pendingOutcome.kind !== "transcript" ||
      handledOutcomeIdRef.current === pendingOutcome.id
    ) {
      return;
    }

    handledOutcomeIdRef.current = pendingOutcome.id;
    const nextDraft = appendVoiceTranscript(
      currentDraftRef.current,
      pendingOutcome.text,
    );
    currentDraftRef.current = nextDraft;
    clearPendingOutcome(threadId, pendingOutcome.id);
    onChangeDraft(nextDraft);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [clearPendingOutcome, inputRef, onChangeDraft, pendingOutcome, threadId]);

  const buttonDisabled =
    isTranscribing ||
    activeSessionElsewhere ||
    pendingOutcomeElsewhere ||
    (phase === "idle" &&
      (locked || loading || !voiceAvailable || pendingOutcomeNeedsReview));
  const buttonLabel = getVoiceButtonLabel({
    isRecording,
    isStarting,
    isTranscribing,
  });
  const buttonTitle = getVoiceButtonTitle({
    activeSessionElsewhere,
    availabilityMessage,
    browserSupported,
    isRecording,
    isStarting,
    isTranscribing,
    loading,
    locked,
    ownerPendingOutcome,
    ownerThreadTitle,
    pendingOutcome,
    pendingOutcomeElsewhere,
    voiceAvailable,
  });

  return {
    buttonDisabled,
    buttonLabel,
    buttonTitle,
    errorMessage: pendingError,
    isRecording,
    isStarting,
    isTranscribing,
    onDismissError: () => {
      if (pendingOutcome?.kind === "error") {
        clearPendingOutcome(threadId, pendingOutcome.id);
      }
    },
    onVoiceButtonClick: useCallback(() => {
      if (isRecording || isStarting) {
        void stopSession();
        return;
      }
      if (
        phase !== "idle" ||
        pendingOutcome !== null ||
        locked ||
        loading ||
        !voiceAvailable
      ) {
        return;
      }
      void startSession({ environmentId, threadId });
    }, [
      environmentId,
      isRecording,
      isStarting,
      loading,
      locked,
      pendingOutcome,
      phase,
      startSession,
      stopSession,
      threadId,
      voiceAvailable,
    ]),
    voiceBusy,
    voiceDurationMs: ownsActiveSession ? durationMs : 0,
  };
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

function getVoiceButtonLabel({
  isRecording,
  isStarting,
  isTranscribing,
}: {
  isRecording: boolean;
  isStarting: boolean;
  isTranscribing: boolean;
}) {
  if (isRecording) {
    return "Stop voice dictation";
  }
  if (isStarting) {
    return "Starting voice dictation";
  }
  if (isTranscribing) {
    return "Transcribing voice dictation";
  }
  return "Start voice dictation";
}

function getVoiceButtonTitle({
  activeSessionElsewhere,
  availabilityMessage,
  browserSupported,
  isRecording,
  isStarting,
  isTranscribing,
  loading,
  locked,
  ownerPendingOutcome,
  ownerThreadTitle,
  pendingOutcome,
  pendingOutcomeElsewhere,
  voiceAvailable,
}: {
  activeSessionElsewhere: boolean;
  availabilityMessage: string;
  browserSupported: boolean;
  isRecording: boolean;
  isStarting: boolean;
  isTranscribing: boolean;
  loading: boolean;
  locked: boolean;
  ownerPendingOutcome: PendingVoiceOutcome | null;
  ownerThreadTitle: string | null;
  pendingOutcome: PendingVoiceOutcome | null;
  pendingOutcomeElsewhere: boolean;
  voiceAvailable: boolean;
}) {
  if (isRecording) {
    return "Stop recording and transcribe";
  }
  if (isStarting) {
    return "Starting microphone capture. Click to cancel.";
  }
  if (isTranscribing) {
    return "Transcribing voice recording";
  }
  if (pendingOutcomeElsewhere) {
    if (ownerPendingOutcome?.kind === "error") {
      return ownerThreadTitle
        ? `Voice dictation failed in ${ownerThreadTitle}. Return there to review it before starting a new recording.`
        : "Voice dictation failed in another thread. Return there to review it before starting a new recording.";
    }
    return ownerThreadTitle
      ? `Voice dictation result is waiting in ${ownerThreadTitle}. Return there to review it before starting a new recording.`
      : "Voice dictation result is waiting in another thread. Return there to review it before starting a new recording.";
  }
  if (pendingOutcome) {
    return "Finish handling the current voice result before starting another recording.";
  }
  if (activeSessionElsewhere) {
    return ownerThreadTitle
      ? `Voice dictation is already active in ${ownerThreadTitle}. Return there to finish it.`
      : "Voice dictation is already active in another thread. Return there to finish it.";
  }
  if (locked) {
    return "Voice dictation is unavailable while the composer is locked";
  }
  if (loading && browserSupported) {
    return "Checking voice transcription availability";
  }
  if (voiceAvailable) {
    return "Record a voice message";
  }
  return availabilityMessage;
}

export { appendVoiceTranscript };
