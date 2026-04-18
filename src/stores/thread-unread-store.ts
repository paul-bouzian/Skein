import { create } from "zustand";

import { useConversationStore } from "./conversation-store";
import {
  selectThreadInAnyPane,
  useWorkspaceStore,
} from "./workspace-store";

type ThreadUnreadState = {
  unreadByThreadId: Record<string, true>;
  markRead: (threadId: string) => void;
};

export const useThreadUnreadStore = create<ThreadUnreadState>((set) => ({
  unreadByThreadId: {},
  markRead: (threadId: string) =>
    set((state) => {
      if (!state.unreadByThreadId[threadId]) return state;
      const rest = { ...state.unreadByThreadId };
      delete rest[threadId];
      return { unreadByThreadId: rest };
    }),
}));

export function selectThreadUnread(threadId: string) {
  return (state: ThreadUnreadState) =>
    Boolean(state.unreadByThreadId[threadId]);
}

// Watch conversation snapshots for transitions into `completed`. When a thread
// just finished while it isn't in the focused pane, flag it as unread so the
// sidebar nudges the user. Focusing the thread clears the flag automatically.
const previousStatuses = new Map<string, string | null>();
for (const [threadId, snapshot] of Object.entries(
  useConversationStore.getState().snapshotsByThreadId,
)) {
  previousStatuses.set(threadId, snapshot?.status ?? null);
}

useConversationStore.subscribe((state, previousState) => {
  // conversation-store mutates on every keystroke (drafts, composer settings);
  // only scan snapshots when the status map actually changed.
  if (state.snapshotsByThreadId === previousState.snapshotsByThreadId) return;

  const seen = new Set<string>();
  for (const [threadId, snapshot] of Object.entries(state.snapshotsByThreadId)) {
    seen.add(threadId);
    const nextStatus = snapshot?.status ?? null;
    const prevStatus = previousStatuses.get(threadId) ?? null;
    previousStatuses.set(threadId, nextStatus);
    const justCompleted =
      nextStatus === "completed" && prevStatus !== "completed";
    if (!justCompleted) continue;
    const visible = selectThreadInAnyPane(threadId)(
      useWorkspaceStore.getState(),
    );
    if (visible) continue;
    useThreadUnreadStore.setState((current) => {
      if (current.unreadByThreadId[threadId]) return current;
      return {
        unreadByThreadId: { ...current.unreadByThreadId, [threadId]: true },
      };
    });
  }
  for (const threadId of previousStatuses.keys()) {
    if (!seen.has(threadId)) previousStatuses.delete(threadId);
  }
});

// Clear the unread flag for any thread that becomes visible in any pane.
let previousVisibleThreadIds = resolveVisibleThreadIds(
  useWorkspaceStore.getState(),
);
useWorkspaceStore.subscribe((state) => {
  const nextVisibleThreadIds = resolveVisibleThreadIds(state);
  for (const threadId of nextVisibleThreadIds) {
    if (!previousVisibleThreadIds.has(threadId)) {
      useThreadUnreadStore.getState().markRead(threadId);
    }
  }
  previousVisibleThreadIds = nextVisibleThreadIds;
});

function resolveVisibleThreadIds(
  state: ReturnType<typeof useWorkspaceStore.getState>,
): Set<string> {
  const ids = new Set<string>();
  for (const pane of Object.values(state.layout.slots)) {
    const threadId = pane?.threadId;
    if (threadId) ids.add(threadId);
  }
  return ids;
}
