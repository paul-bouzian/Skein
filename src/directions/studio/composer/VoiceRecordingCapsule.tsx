import type { RefObject } from "react";

import { CloseIcon } from "../../../shared/Icons";
import { formatVoiceDuration } from "./voice-duration";

type Props = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  durationMs: number;
  errorMessage: string | null;
  isRecording: boolean;
  isTranscribing: boolean;
  onDismissError: () => void;
};

export function VoiceRecordingCapsule({
  canvasRef,
  durationMs,
  errorMessage,
  isRecording,
  isTranscribing,
  onDismissError,
}: Props) {
  if (!isRecording && !isTranscribing && !errorMessage) {
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
          <span className="tx-voice-capsule__duration" aria-hidden="true">
            {formatVoiceDuration(durationMs)}
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
        <span className="tx-voice-capsule__duration" aria-hidden="true">
          {formatVoiceDuration(durationMs)}
        </span>
      </div>
      <div className="tx-voice-capsule__progress" aria-hidden="true" />
      <div className="tx-voice-capsule__body">
        Converting speech to text and inserting it into the composer.
      </div>
    </div>
  );
}
