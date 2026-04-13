import { useMemo } from "react";

import { APP_NAME } from "../../lib/app-identity";
import {
  findThreadInWorkspace,
  useWorkspaceStore,
  selectSelectedProject,
  selectSelectedEnvironment,
  selectSelectedThread,
} from "../../stores/workspace-store";
import {
  selectOwnerPendingVoiceOutcome,
  useVoiceSessionStore,
} from "../../stores/voice-session-store";
import { MicIcon } from "../../shared/Icons";
import { formatVoiceDuration } from "./composer/voice-duration";
import "./StudioStatusBar.css";

export function StudioStatusBar() {
  const workspaceSnapshot = useWorkspaceStore((state) => state.snapshot);
  const bootstrapStatus = useWorkspaceStore((s) => s.bootstrapStatus);
  const selectedProject = useWorkspaceStore(selectSelectedProject);
  const selectedEnvironment = useWorkspaceStore(selectSelectedEnvironment);
  const selectedThread = useWorkspaceStore(selectSelectedThread);
  const selectThread = useWorkspaceStore((state) => state.selectThread);
  const voicePhase = useVoiceSessionStore((state) => state.phase);
  const voiceDurationMs = useVoiceSessionStore((state) => state.durationMs);
  const voiceOwnerThreadId = useVoiceSessionStore((state) => state.ownerThreadId);
  const voiceOwnerPendingOutcome = useVoiceSessionStore(
    selectOwnerPendingVoiceOutcome,
  );

  const voiceOwner = useMemo(
    () => findThreadInWorkspace(workspaceSnapshot, voiceOwnerThreadId),
    [voiceOwnerThreadId, workspaceSnapshot],
  );
  const showVoiceIndicator =
    voiceOwnerThreadId !== null &&
    voiceOwnerThreadId !== selectedThread?.id &&
    (voicePhase !== "idle" || voiceOwnerPendingOutcome !== null);
  const showVoiceDuration = voicePhase !== "idle" || voiceDurationMs > 0;
  const voiceIndicatorLabel =
    voiceOwnerPendingOutcome?.kind === "error"
      ? "Voice transcription failed"
      : voiceOwnerPendingOutcome?.kind === "transcript"
        ? "Voice note ready"
        : voicePhase === "transcribing"
          ? "Transcribing voice"
          : voicePhase === "starting"
            ? "Starting voice"
            : "Listening";
  const voiceIndicatorTitle = voiceOwner
    ? voiceOwnerPendingOutcome?.kind === "error"
      ? `Return to ${voiceOwner.thread.title} to review the voice error`
      : voiceOwnerPendingOutcome?.kind === "transcript"
        ? `Return to ${voiceOwner.thread.title} to review the voice result`
        : `Return to ${voiceOwner.thread.title}`
    : "Return to the source thread";

  const breadcrumb = [
    selectedProject?.name,
    selectedEnvironment?.name,
    selectedThread?.title,
  ]
    .filter(Boolean)
    .join(" / ");

  return (
    <div className="studio-statusbar">
      <div className="studio-statusbar__left" />
      <div className="studio-statusbar__center">
        {bootstrapStatus && (
          <span className="studio-statusbar__version">
            {APP_NAME} {bootstrapStatus.appVersion}
          </span>
        )}
      </div>
      <div className="studio-statusbar__right">
        {showVoiceIndicator ? (
          <button
            type="button"
            className="studio-statusbar__voice-indicator"
            title={voiceIndicatorTitle}
            onClick={() => {
              if (voiceOwnerThreadId) {
                selectThread(voiceOwnerThreadId);
              }
            }}
          >
            <MicIcon size={12} />
            <span className="studio-statusbar__voice-label">
              {voiceIndicatorLabel}
              {voiceOwner ? ` in ${voiceOwner.thread.title}` : ""}
            </span>
            {showVoiceDuration ? (
              <span className="studio-statusbar__voice-duration">
                {formatVoiceDuration(voiceDurationMs)}
              </span>
            ) : null}
          </button>
        ) : null}
        {breadcrumb && (
          <span className="studio-statusbar__breadcrumb">{breadcrumb}</span>
        )}
      </div>
    </div>
  );
}
