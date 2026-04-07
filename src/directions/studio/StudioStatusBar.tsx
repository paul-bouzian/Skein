import { useMemo } from "react";

import {
  useWorkspaceStore,
  selectProjects,
  selectSelectedProject,
  selectSelectedEnvironment,
  selectSelectedThread,
} from "../../stores/workspace-store";
import { useVoiceSessionStore } from "../../stores/voice-session-store";
import { MicIcon } from "../../shared/Icons";
import { RuntimeIndicator } from "../../shared/RuntimeIndicator";
import { formatVoiceDuration } from "./composer/voice-duration";
import "./StudioStatusBar.css";

export function StudioStatusBar() {
  const projects = useWorkspaceStore(selectProjects);
  const bootstrapStatus = useWorkspaceStore((s) => s.bootstrapStatus);
  const selectedProject = useWorkspaceStore(selectSelectedProject);
  const selectedEnvironment = useWorkspaceStore(selectSelectedEnvironment);
  const selectedThread = useWorkspaceStore(selectSelectedThread);
  const selectThread = useWorkspaceStore((state) => state.selectThread);
  const voicePhase = useVoiceSessionStore((state) => state.phase);
  const voiceDurationMs = useVoiceSessionStore((state) => state.durationMs);
  const voiceOwnerThreadId = useVoiceSessionStore((state) => state.ownerThreadId);

  const runningEnvironments = projects.flatMap((p) =>
    p.environments.filter((e) => e.runtime.state === "running"),
  );
  const voiceOwner = useMemo(
    () => findVoiceOwner(projects, voiceOwnerThreadId),
    [projects, voiceOwnerThreadId],
  );
  const showVoiceIndicator =
    voicePhase !== "idle" &&
    voiceOwnerThreadId !== null &&
    voiceOwnerThreadId !== selectedThread?.id;
  const voiceIndicatorLabel =
    voicePhase === "transcribing"
      ? "Transcribing voice"
      : voicePhase === "starting"
        ? "Starting voice"
        : "Listening";

  const breadcrumb = [
    selectedProject?.name,
    selectedEnvironment?.name,
    selectedThread?.title,
  ]
    .filter(Boolean)
    .join(" / ");

  return (
    <div className="studio-statusbar">
      <div className="studio-statusbar__left">
        {runningEnvironments.length > 0 ? (
          <span className="studio-statusbar__runtimes">
            {runningEnvironments.map((env) => (
              <span key={env.id} className="studio-statusbar__runtime-item">
                <RuntimeIndicator state={env.runtime.state} />
                <span>{env.name}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="studio-statusbar__idle">No runtimes active</span>
        )}
      </div>
      <div className="studio-statusbar__center">
        {bootstrapStatus && (
          <span className="studio-statusbar__version">
            ThreadEx {bootstrapStatus.appVersion}
          </span>
        )}
      </div>
      <div className="studio-statusbar__right">
        {showVoiceIndicator ? (
          <button
            type="button"
            className="studio-statusbar__voice-indicator"
            title={
              voiceOwner
                ? `Return to ${voiceOwner.thread.title}`
                : "Return to the source thread"
            }
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
            <span className="studio-statusbar__voice-duration">
              {formatVoiceDuration(voiceDurationMs)}
            </span>
          </button>
        ) : null}
        {breadcrumb && (
          <span className="studio-statusbar__breadcrumb">{breadcrumb}</span>
        )}
      </div>
    </div>
  );
}

function findVoiceOwner(
  projects: ReturnType<typeof selectProjects>,
  threadId: string | null,
) {
  if (!threadId) {
    return null;
  }

  for (const project of projects) {
    for (const environment of project.environments) {
      const thread = environment.threads.find((candidate) => candidate.id === threadId);
      if (thread) {
        return { environment, project, thread };
      }
    }
  }

  return null;
}
