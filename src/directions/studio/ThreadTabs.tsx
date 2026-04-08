import { useWorkspaceStore, selectSelectedEnvironment } from "../../stores/workspace-store";
import { useConversationStore } from "../../stores/conversation-store";
import {
  selectOwnerPendingVoiceOutcome,
  useVoiceSessionStore,
} from "../../stores/voice-session-store";
import { confirm } from "@tauri-apps/plugin-dialog";
import * as bridge from "../../lib/bridge";
import { CloseIcon, PlusIcon } from "../../shared/Icons";
import type { ThreadConversationSnapshot, ThreadRecord } from "../../lib/types";
import "./ThreadTabs.css";

export function ThreadTabs() {
  const selectedEnvironment = useWorkspaceStore(selectSelectedEnvironment);
  const selectedThreadId = useWorkspaceStore((s) => s.selectedThreadId);
  const selectThread = useWorkspaceStore((s) => s.selectThread);
  const refreshSnapshot = useWorkspaceStore((s) => s.refreshSnapshot);
  const snapshotsByThreadId = useConversationStore((state) => state.snapshotsByThreadId);
  const voicePhase = useVoiceSessionStore((state) => state.phase);
  const voiceOwnerThreadId = useVoiceSessionStore((state) => state.ownerThreadId);
  const ownerPendingVoiceOutcome = useVoiceSessionStore(
    selectOwnerPendingVoiceOutcome,
  );

  if (!selectedEnvironment) return null;

  const activeThreads = selectedEnvironment.threads.filter(
    (t) => t.status === "active",
  );

  async function handleNewThread() {
    if (!selectedEnvironment) return;
    const thread = await bridge.createThread({ environmentId: selectedEnvironment.id });
    await refreshSnapshot();
    selectThread(thread.id);
  }

  async function handleArchiveThread(thread: ThreadRecord) {
    const confirmed = await confirm("Are you sure you want to archive this thread?", {
      title: "Archive Thread",
      kind: "warning",
      okLabel: "Archive",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;

    await bridge.archiveThread({ threadId: thread.id });
    if (selectedThreadId === thread.id) {
      selectThread(null);
    }
    await refreshSnapshot();
  }

  return (
    <div className="thread-tabs">
      <div className="thread-tabs__list">
        {activeThreads.map((thread) => {
          const voiceWorkOwnedByThread =
            voiceOwnerThreadId === thread.id &&
            (voicePhase !== "idle" || ownerPendingVoiceOutcome !== null);
          const archiveTitle = voiceWorkOwnedByThread
            ? `Finish handling voice dictation in ${thread.title} before archiving it.`
            : `Archive ${thread.title}`;

          return (
            <div
              key={thread.id}
              className={`thread-tab ${selectedThreadId === thread.id ? "thread-tab--active" : ""}`}
            >
              <button
                type="button"
                className="thread-tab__select"
                title={thread.title}
                onClick={() => selectThread(thread.id)}
              >
                {needsAttention(snapshotsByThreadId[thread.id]) ? (
                  <span className="thread-tab__status-dot" aria-hidden="true" />
                ) : null}
                <span className="thread-tab__title">{thread.title}</span>
              </button>
              <button
                type="button"
                className="thread-tab__close"
                aria-label={`Archive ${thread.title}`}
                disabled={voiceWorkOwnedByThread}
                title={archiveTitle}
                onClick={() => void handleArchiveThread(thread)}
              >
                <CloseIcon size={10} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="thread-tabs__new"
        title="New thread"
        onClick={() => void handleNewThread()}
      >
        <PlusIcon size={12} />
      </button>
    </div>
  );
}

function needsAttention(snapshot: ThreadConversationSnapshot | undefined) {
  if (!snapshot) return false;
  return (
    snapshot.pendingInteractions.length > 0 ||
    Boolean(snapshot.proposedPlan?.isAwaitingDecision)
  );
}
