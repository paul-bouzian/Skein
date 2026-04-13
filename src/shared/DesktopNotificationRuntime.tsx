import { useEffect, useRef, useState } from "react";
import { sendNotification } from "@tauri-apps/plugin-notification";

import {
  collectDesktopNotificationCandidates,
  type DesktopNotificationCandidate,
} from "../lib/desktop-notifications";
import { playNotificationAlertSound } from "../lib/notification-sounds";
import type {
  NotificationSoundSettings,
  ThreadConversationSnapshot,
  WorkspaceSnapshot,
} from "../lib/types";
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
  const selectedThreadId = useWorkspaceStore((state) => state.selectedThreadId);
  const desktopNotificationsEnabled = useWorkspaceStore(
    (state) => state.snapshot?.settings.desktopNotificationsEnabled ?? false,
  );
  const notificationSounds = useWorkspaceStore(
    (state) => state.snapshot?.settings.notificationSounds ?? null,
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

    const canSendDesktopNotifications =
      desktopNotificationsEnabled && appInBackground;
    const canPlaySounds = hasEnabledNotificationSounds(notificationSounds);
    if (!canSendDesktopNotifications && !canPlaySounds) {
      return;
    }

    const changedThreadIds = collectChangedThreadIds(
      previousSnapshots,
      snapshotsByThreadId,
    );
    if (changedThreadIds.length === 0) {
      return;
    }

    const candidates = collectDesktopNotificationCandidates(
      previousSnapshots,
      snapshotsByThreadId,
      {
        suppressUnknownThreads,
        threadIds: changedThreadIds,
      },
    );

    if (canSendDesktopNotifications) {
      for (const candidate of candidates) {
        if (!snapshotsByThreadId[candidate.threadId]) {
          continue;
        }

        const copy = buildNotificationCopy(workspaceSnapshot, candidate);
        try {
          sendNotification(copy);
        } catch {
          // Ignore OS notification delivery failures; the feature is best-effort.
        }
      }
    }

    const soundId = resolveNotificationSound(
      candidates,
      notificationSounds,
      selectedThreadId,
      appInBackground,
    );
    if (!soundId) {
      return;
    }

    void playNotificationAlertSound(soundId).catch(() => {
      // Ignore sound playback failures; notification sounds are best-effort.
    });
  }, [
    appInBackground,
    desktopNotificationsEnabled,
    notificationSounds,
    selectedThreadId,
    snapshotsByThreadId,
    workspaceSnapshot,
  ]);

  return null;
}

function hasEnabledNotificationSounds(
  settings: NotificationSoundSettings | null,
): boolean {
  if (!settings) {
    return false;
  }

  return settings.attention.enabled || settings.completion.enabled;
}

function collectChangedThreadIds(
  previousSnapshotsByThreadId: Record<string, ThreadConversationSnapshot>,
  nextSnapshotsByThreadId: Record<string, ThreadConversationSnapshot>,
): string[] {
  const threadIds = Object.keys(nextSnapshotsByThreadId).filter(
    (threadId) =>
      previousSnapshotsByThreadId[threadId] !== nextSnapshotsByThreadId[threadId],
  );
  threadIds.sort();
  return threadIds;
}

function resolveNotificationSound(
  candidates: DesktopNotificationCandidate[],
  settings: NotificationSoundSettings | null,
  selectedThreadId: string | null,
  appInBackground: boolean,
) {
  if (!settings) {
    return null;
  }

  const eligibleAttention = candidates.find(
    (candidate) =>
      candidate.kind === "attention" &&
      settings.attention.enabled &&
      isSoundCandidateEligible(candidate.threadId, selectedThreadId, appInBackground),
  );
  if (eligibleAttention) {
    return settings.attention.sound;
  }

  const eligibleCompletion = candidates.find(
    (candidate) =>
      candidate.kind === "completed" &&
      settings.completion.enabled &&
      isSoundCandidateEligible(candidate.threadId, selectedThreadId, appInBackground),
  );
  return eligibleCompletion ? settings.completion.sound : null;
}

function isSoundCandidateEligible(
  candidateThreadId: string,
  selectedThreadId: string | null,
  appInBackground: boolean,
): boolean {
  return appInBackground || candidateThreadId !== selectedThreadId;
}
