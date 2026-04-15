import { confirm } from "@tauri-apps/plugin-dialog";

import * as bridge from "../../lib/bridge";
import type {
  ConversationComposerSettings,
  ConversationImageAttachment,
  EnvironmentRecord,
  ThreadRecord,
  WorkspaceSnapshot,
} from "../../lib/types";
import { useConversationStore } from "../../stores/conversation-store";
import { useVoiceSessionStore } from "../../stores/voice-session-store";
import {
  useWorkspaceStore,
  type SlotKey,
} from "../../stores/workspace-store";
import type { EnvSelection } from "./draft/EnvironmentSelector";

export async function createThreadForSelection() {
  const environment = selectedEnvironment();
  if (!environment) {
    return false;
  }
  return createThreadForEnvironment(environment.id);
}

export async function createThreadForEnvironment(environmentId: string) {
  const thread = await bridge.createThread({ environmentId });
  const refreshed = await useWorkspaceStore.getState().refreshSnapshot();
  if (!refreshed) {
    return false;
  }
  useWorkspaceStore.getState().selectThread(thread.id);
  return true;
}

export async function createManagedWorktreeForSelection() {
  const projectId = selectedProjectId();
  if (!projectId) {
    return false;
  }

  const result = await bridge.createManagedWorktree(projectId);
  const refreshed = await useWorkspaceStore.getState().refreshSnapshot();
  if (!refreshed) {
    return false;
  }
  useWorkspaceStore.getState().selectThread(result.thread.id);
  return true;
}

export function openThreadDraftForProject(
  projectId: string,
  slot?: SlotKey,
): SlotKey | null {
  return useWorkspaceStore.getState().openThreadDraft(projectId, slot);
}

export type SendThreadDraftInput = {
  paneId: SlotKey;
  projectId: string;
  selection: EnvSelection;
  text: string;
  images?: ConversationImageAttachment[];
  composer?: ConversationComposerSettings | null;
};

export type SendThreadDraftResult =
  | { ok: true; thread: ThreadRecord }
  | { ok: false; error: string };

export async function sendThreadDraft(
  input: SendThreadDraftInput,
): Promise<SendThreadDraftResult> {
  const { paneId, projectId, selection, text, composer } = input;
  const images = input.images ?? [];
  if (text.trim().length === 0 && images.length === 0) {
    return { ok: false, error: "Message is empty" };
  }

  let thread: ThreadRecord;
  try {
    thread = await resolveDraftThread(projectId, selection);
  } catch (cause: unknown) {
    return {
      ok: false,
      error:
        cause instanceof Error ? cause.message : "Failed to create thread",
    };
  }

  const refreshed = await useWorkspaceStore.getState().refreshSnapshot();
  if (!refreshed) {
    return {
      ok: false,
      error: "Thread created, but the workspace failed to refresh.",
    };
  }

  // Seed the conversation store's composer with the draft picks so the
  // first send carries the user's chosen model / effort / mode and the
  // thread view stays consistent with what they configured in the draft.
  if (composer) {
    useConversationStore.setState((state) => ({
      composerByThreadId: {
        ...state.composerByThreadId,
        [thread.id]: composer,
      },
    }));
  }

  // Hand the message off to ThreadConversation: it consumes the pending
  // first message on mount and runs its own handleSend, which already wires
  // up the optimistic user message and the FirstPromptNamingNotice spinner.
  useConversationStore.getState().enqueuePendingFirstMessage(thread.id, {
    text: text.trim(),
    images,
    composer: composer ?? null,
  });

  // Close the draft and switch the pane — ThreadConversation mounts and
  // takes over from here.
  useWorkspaceStore.getState().closeThreadDraft(paneId);
  useWorkspaceStore.getState().openThreadInSlot(paneId, thread.id);

  return { ok: true, thread };
}

async function resolveDraftThread(
  projectId: string,
  selection: EnvSelection,
): Promise<ThreadRecord> {
  if (selection.kind === "new") {
    const trimmedName = selection.name.trim();
    const result = await bridge.createManagedWorktree(projectId, {
      baseBranch: selection.baseBranch,
      ...(trimmedName.length > 0 ? { name: trimmedName } : {}),
    });
    return result.thread;
  }

  if (selection.kind === "existing") {
    return bridge.createThread({ environmentId: selection.environmentId });
  }

  const localEnv = findLocalEnvironment(projectId);
  if (!localEnv) {
    throw new Error("No local environment found for this project.");
  }
  return bridge.createThread({ environmentId: localEnv.id });
}

function findLocalEnvironment(projectId: string): EnvironmentRecord | null {
  const snapshot = useWorkspaceStore.getState().snapshot;
  const project = snapshot?.projects.find(
    (candidate) => candidate.id === projectId,
  );
  return project?.environments.find((env) => env.kind === "local") ?? null;
}

export async function archiveThreadWithConfirmation(threadId: string) {
  const snapshot = useWorkspaceStore.getState().snapshot;
  const target = findThread(snapshot, threadId);
  if (!target || ownsPendingVoiceWork(threadId)) {
    return false;
  }

  const confirmed = await confirm("Are you sure you want to archive this thread?", {
    title: "Archive Thread",
    kind: "warning",
    okLabel: "Archive",
    cancelLabel: "Cancel",
  });
  if (!confirmed) {
    return false;
  }

  const latestSnapshot = useWorkspaceStore.getState().snapshot;
  const latestTarget = findThread(latestSnapshot, threadId);
  if (!latestTarget || ownsPendingVoiceWork(threadId)) {
    return false;
  }

  const archivedEnvironmentId = latestTarget.environment.id;
  const archivedEnvironmentKind = latestTarget.environment.kind;

  await bridge.archiveThread({ threadId: latestTarget.thread.id });
  useWorkspaceStore.getState().removeThread(latestTarget.thread.id);
  const refreshed = await useWorkspaceStore.getState().refreshSnapshot();

  if (refreshed && archivedEnvironmentKind !== "local") {
    await maybePromptDeleteEmptyWorktree(archivedEnvironmentId);
  }

  return refreshed;
}

async function maybePromptDeleteEmptyWorktree(environmentId: string) {
  const targetEnv = findEnvironmentById(environmentId);
  if (!targetEnv || targetEnv.kind === "local") return;
  const stillHasActiveThread = targetEnv.threads.some(
    (thread) => thread.status === "active",
  );
  if (stillHasActiveThread) return;

  const approved = await confirm(
    `The worktree "${targetEnv.name}" has no more active threads. Delete it?`,
    {
      title: "Delete empty worktree",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Keep",
    },
  );
  if (!approved) return;

  try {
    await bridge.deleteWorktreeEnvironment(environmentId);
    await useWorkspaceStore.getState().refreshSnapshot();
  } catch {
    // A failure to delete the worktree is not worth surfacing a duplicate
    // notice here; the user can retry from the chip menu.
  }
}

function findEnvironmentById(
  environmentId: string,
): EnvironmentRecord | null {
  const snapshot = useWorkspaceStore.getState().snapshot;
  if (!snapshot) return null;
  for (const project of snapshot.projects) {
    const match = project.environments.find(
      (env) => env.id === environmentId,
    );
    if (match) return match;
  }
  return null;
}

export function selectAdjacentThread(direction: "next" | "previous") {
  const environment = selectedEnvironment();
  if (!environment) {
    return false;
  }

  const activeThreads = environment.threads.filter((thread) => thread.status === "active");
  if (activeThreads.length === 0) {
    return false;
  }

  const currentIndex = activeThreads.findIndex(
    (thread) => thread.id === useWorkspaceStore.getState().selectedThreadId,
  );
  const baseIndex =
    currentIndex === -1 ? (direction === "next" ? -1 : 0) : currentIndex;
  const offset = direction === "next" ? 1 : -1;
  const nextIndex = (baseIndex + offset + activeThreads.length) % activeThreads.length;
  const nextThread = activeThreads[nextIndex];
  if (!nextThread) {
    return false;
  }

  useWorkspaceStore.getState().selectThread(nextThread.id);
  return true;
}

export function selectAdjacentEnvironment(direction: "next" | "previous") {
  const state = useWorkspaceStore.getState();
  const snapshot = state.snapshot;
  const orderedEnvironments = listOrderedEnvironments(snapshot);
  if (orderedEnvironments.length === 0) {
    return false;
  }

  const selectedEnvironment = resolveSelectedEnvironment(
    snapshot,
    state.selectedProjectId,
    state.selectedEnvironmentId,
  );
  const currentIndex = selectedEnvironment
    ? orderedEnvironments.findIndex(
        (environment) => environment.id === selectedEnvironment.id,
      )
    : -1;
  const baseIndex =
    currentIndex === -1 ? (direction === "next" ? -1 : 0) : currentIndex;
  const offset = direction === "next" ? 1 : -1;
  const nextIndex =
    (baseIndex + offset + orderedEnvironments.length) % orderedEnvironments.length;
  const nextEnvironment = orderedEnvironments[nextIndex];
  if (!nextEnvironment) {
    return false;
  }

  useWorkspaceStore.getState().selectEnvironment(nextEnvironment.id);
  return true;
}

function selectedEnvironment() {
  const state = useWorkspaceStore.getState();
  return resolveSelectedEnvironment(
    state.snapshot,
    state.selectedProjectId,
    state.selectedEnvironmentId,
  );
}

function selectedProjectId() {
  const state = useWorkspaceStore.getState();
  if (state.selectedProjectId) {
    return state.selectedProjectId;
  }
  if (state.snapshot && state.selectedEnvironmentId) {
    for (const project of state.snapshot.projects) {
      if (project.environments.some((environment) => environment.id === state.selectedEnvironmentId)) {
        return project.id;
      }
    }
  }
  return null;
}

function findThread(snapshot: WorkspaceSnapshot | null, threadId: string) {
  if (!snapshot) {
    return null;
  }
  for (const project of snapshot.projects) {
    for (const environment of project.environments) {
      const thread = environment.threads.find((candidate) => candidate.id === threadId);
      if (thread) {
        return { project, environment, thread };
      }
    }
  }
  return null;
}

function listOrderedEnvironments(snapshot: WorkspaceSnapshot | null): EnvironmentRecord[] {
  if (!snapshot) {
    return [];
  }
  return snapshot.projects.flatMap(visibleProjectEnvironments);
}

function resolveSelectedEnvironment(
  snapshot: WorkspaceSnapshot | null,
  selectedProjectId: string | null,
  selectedEnvironmentId: string | null,
) {
  if (!snapshot || !selectedEnvironmentId) {
    return null;
  }

  const orderedEnvironments = listOrderedEnvironments(snapshot);
  const selectedEnvironment = orderedEnvironments.find(
    (environment) => environment.id === selectedEnvironmentId,
  );
  if (selectedEnvironment) {
    return selectedEnvironment;
  }

  const project = snapshot.projects.find(
    (candidate) => candidate.id === selectedProjectId,
  );
  return project ? visibleProjectEnvironments(project)[0] ?? null : null;
}

function visibleProjectEnvironments(project: WorkspaceSnapshot["projects"][number]) {
  return project.environments.filter(
    (environment) => environment.kind === "local" || !project.sidebarCollapsed,
  );
}

function ownsPendingVoiceWork(threadId: string) {
  const state = useVoiceSessionStore.getState();
  return (
    state.ownerThreadId === threadId &&
    (state.phase !== "idle" || state.pendingOutcomesByThreadId[threadId] != null)
  );
}
