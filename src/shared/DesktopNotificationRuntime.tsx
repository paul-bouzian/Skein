import { useEffect, useRef, useState } from "react";
import { sendNotification } from "@tauri-apps/plugin-notification";

import {
  collectDesktopNotificationCandidates,
  type DesktopNotificationCandidate,
} from "../lib/desktop-notifications";
import type { ThreadConversationSnapshot, WorkspaceSnapshot } from "../lib/types";
import { useConversationStore } from "../stores/conversation-store";
import {
  findThreadInWorkspace,
  useWorkspaceStore,
} from "../stores/workspace-store";

type ThreadMetadata = {
  title: string;
  environmentName: string;
};

const DEFAULT_THREAD_METADATA: ThreadMetadata = {
  title: "Untitled thread",
  environmentName: "this environment",
};

function isAppInBackground(): boolean {
  return (
    document.visibilityState !== "visible" ||
    !document.hasFocus()
  );
}

function resolveThreadMetadata(
  workspaceSnapshot: WorkspaceSnapshot | null,
  threadId: string,
): ThreadMetadata {
  if (!workspaceSnapshot) {
    return DEFAULT_THREAD_METADATA;
  }

  const threadLocation = findThreadInWorkspace(workspaceSnapshot, threadId);
  if (!threadLocation) {
    return DEFAULT_THREAD_METADATA;
  }

  return {
    title: threadLocation.thread.title.trim() || DEFAULT_THREAD_METADATA.title,
    environmentName:
      threadLocation.environment.name.trim() || DEFAULT_THREAD_METADATA.environmentName,
  };
}

function buildNotificationCopy(
  workspaceSnapshot: WorkspaceSnapshot | null,
  candidate: DesktopNotificationCandidate,
): { title: string; body: string } {
  const metadata = resolveThreadMetadata(
    workspaceSnapshot,
    candidate.threadId,
  );

  if (candidate.kind === "completed") {
    return {
      title: metadata.title,
      body: `Finished working in ${metadata.environmentName}.`,
    };
  }

  return {
    title: metadata.title,
    body:
      candidate.attentionKind === "approval"
        ? `Needs your approval in ${metadata.environmentName}.`
        : `Needs your input in ${metadata.environmentName}.`,
  };
}

export function DesktopNotificationRuntime() {
  const workspaceSnapshot = useWorkspaceStore((state) => state.snapshot);
  const desktopNotificationsEnabled = useWorkspaceStore(
    (state) => state.snapshot?.settings.desktopNotificationsEnabled ?? false,
  );
  const snapshotsByThreadId = useConversationStore(
    (state) => state.snapshotsByThreadId,
  );
  const previousSnapshotsRef = useRef<Record<string, ThreadConversationSnapshot>>({});
  const readyRef = useRef(false);
  const suppressUnknownThreadsRef = useRef(false);
  const [appInBackground, setAppInBackground] = useState(isAppInBackground);

  useEffect(() => {
    function updateBackgroundState() {
      setAppInBackground(isAppInBackground());
    }

    window.addEventListener("focus", updateBackgroundState);
    window.addEventListener("blur", updateBackgroundState);
    document.addEventListener("visibilitychange", updateBackgroundState);

    return () => {
      window.removeEventListener("focus", updateBackgroundState);
      window.removeEventListener("blur", updateBackgroundState);
      document.removeEventListener("visibilitychange", updateBackgroundState);
    };
  }, []);

  useEffect(() => {
    if (!readyRef.current) {
      previousSnapshotsRef.current = snapshotsByThreadId;
      suppressUnknownThreadsRef.current =
        Object.keys(snapshotsByThreadId).length === 0;
      readyRef.current = true;
      return;
    }

    const previousSnapshots = previousSnapshotsRef.current;
    const suppressUnknownThreads = suppressUnknownThreadsRef.current;
    previousSnapshotsRef.current = snapshotsByThreadId;
    suppressUnknownThreadsRef.current = false;

    if (!desktopNotificationsEnabled || !appInBackground) {
      return;
    }

    const candidates = collectDesktopNotificationCandidates(
      previousSnapshots,
      snapshotsByThreadId,
      { suppressUnknownThreads },
    );

    for (const candidate of candidates) {
      const snapshot = snapshotsByThreadId[candidate.threadId];
      if (!snapshot) {
        continue;
      }

      const copy = buildNotificationCopy(workspaceSnapshot, candidate);
      try {
        sendNotification(copy);
      } catch {
        // Ignore OS notification delivery failures; the feature is best-effort.
      }
    }
  }, [appInBackground, desktopNotificationsEnabled, snapshotsByThreadId, workspaceSnapshot]);

  return null;
}
