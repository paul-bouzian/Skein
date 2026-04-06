import type { RefObject } from "react";

import { CloseIcon } from "../../../shared/Icons";

type Props = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  durationMs: number;
  errorMessage: string | null;
  isRecording: boolean;
  isTranscribing: boolean;
  onDismissError: () => void;
  unavailableMessage: string | null;
};

export function VoiceRecordingCapsule({
  canvasRef,
  durationMs,
  errorMessage,
  isRecording,
  isTranscribing,
  onDismissError,
  unavailableMessage,
}: Props) {
  if (!isRecording && !isTranscribing && !errorMessage && !unavailableMessage) {
    return null;
  }

  if (errorMessage) {
    return (
      <div
        className="tx-voice-capsule tx-voice-capsule--error"
        role="status"
        aria-live="polite"
      >
        <div className="tx-voice-capsule__header">
          <div className="tx-voice-capsule__title-group">
            <span className="tx-voice-capsule__eyebrow">Voice</span>
            <span className="tx-voice-capsule__title">
              Voice transcription failed
            </span>
          </div>
          <button
            type="button"
            className="tx-voice-capsule__dismiss"
            aria-label="Dismiss voice error"
            onClick={onDismissError}
          >
            <CloseIcon size={12} />
          </button>
        </div>
        <div className="tx-voice-capsule__body">{errorMessage}</div>
      </div>
    );
  }

  if (unavailableMessage) {
    return (
      <div
        className="tx-voice-capsule tx-voice-capsule--unavailable"
        role="status"
        aria-live="polite"
      >
        <div className="tx-voice-capsule__header">
          <div className="tx-voice-capsule__title-group">
            <span className="tx-voice-capsule__eyebrow">Voice</span>
            <span className="tx-voice-capsule__title">Voice unavailable</span>
          </div>
        </div>
        <div className="tx-voice-capsule__body">{unavailableMessage}</div>
      </div>
    );
  }

  if (isRecording) {
    return (
      <div
        className="tx-voice-capsule tx-voice-capsule--recording"
        role="status"
        aria-live="polite"
      >
        <div className="tx-voice-capsule__header">
          <div className="tx-voice-capsule__title-group">
            <span className="tx-voice-capsule__eyebrow">Voice</span>
            <span className="tx-voice-capsule__title">Listening</span>
          </div>
          <span className="tx-voice-capsule__duration">
            {formatDuration(durationMs)}
          </span>
        </div>
        <canvas
          ref={canvasRef}
          className="tx-voice-capsule__canvas"
          aria-hidden="true"
        />
      </div>
    );
  }

  return (
    <div
      className="tx-voice-capsule tx-voice-capsule--transcribing"
      role="status"
      aria-live="polite"
    >
      <div className="tx-voice-capsule__header">
        <div className="tx-voice-capsule__title-group">
          <span className="tx-voice-capsule__eyebrow">Voice</span>
          <span className="tx-voice-capsule__title">
            Transcribing voice note
          </span>
        </div>
        <span className="tx-voice-capsule__duration">
          {formatDuration(durationMs)}
        </span>
      </div>
      <div className="tx-voice-capsule__progress" aria-hidden="true" />
      <div className="tx-voice-capsule__body">
        Converting speech to text and inserting it into the composer.
      </div>
    </div>
  );
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
