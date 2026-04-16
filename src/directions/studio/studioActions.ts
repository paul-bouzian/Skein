import { confirm } from "@tauri-apps/plugin-dialog";

import * as bridge from "../../lib/bridge";
import type {
  ComposerMentionBindingInput,
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
  mentionBindings?: ComposerMentionBindingInput[];
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
  const mentionBindings = input.mentionBindings ?? [];
  if (text.trim().length === 0 && images.length === 0) {
    return { ok: false, error: "Message is empty" };
  }

  let resolved: ResolvedDraftThread;
  try {
    resolved = await resolveDraftThread(projectId, selection);
  } catch (cause: unknown) {
    return {
      ok: false,
      error:
        cause instanceof Error ? cause.message : "Failed to create thread",
    };
  }
  const { thread, environment } = resolved;

  // Stage the new thread in the local snapshot so pane resolution works
  // before `refreshSnapshot` completes. Without this, a slow refresh would
  // leave the pane rendering the project overview instead of the thread.
  mergeCreatedThreadIntoSnapshot(projectId, thread, environment);

  // Refresh runs in the background. Earlier versions awaited it and
  // surfaced failures as an error, which drove users to retry and
  // accidentally create duplicate threads/worktrees — the backend
  // already committed to the one we just got back.
  void useWorkspaceStore.getState().refreshSnapshot();

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
    mentionBindings,
    composer: composer ?? null,
  });

  // Switch the pane in one store update. setPaneSelection also clears the
  // draft slot, which avoids a transient "no environment selected" step.
  useWorkspaceStore.getState().setPaneSelection(paneId, {
    projectId,
    environmentId: thread.environmentId,
    threadId: thread.id,
  });

  return { ok: true, thread };
}

type ResolvedDraftThread = {
  thread: ThreadRecord;
  // Populated only for "new worktree" flows, where the backend returns the
  // freshly-created environment alongside the thread.
  environment?: EnvironmentRecord;
};

async function resolveDraftThread(
  projectId: string,
  selection: EnvSelection,
): Promise<ResolvedDraftThread> {
  if (selection.kind === "new") {
    const trimmedName = selection.name.trim();
    const baseBranch = selection.baseBranch.trim();
    const result = await bridge.createManagedWorktree(projectId, {
      // Leaving baseBranch empty lets the backend fall back to
      // resolve_base_reference (remote/upstream), which is how the legacy
      // standalone flow worked and matters for detached-HEAD repos.
      ...(baseBranch.length > 0 ? { baseBranch } : {}),
      ...(trimmedName.length > 0 ? { name: trimmedName } : {}),
    });
    return { thread: result.thread, environment: result.environment };
  }

  if (selection.kind === "existing") {
    const thread = await bridge.createThread({
      environmentId: selection.environmentId,
    });
    return { thread };
  }

  const localEnv = findLocalEnvironment(projectId);
  if (!localEnv) {
    throw new Error("No local environment found for this project.");
  }
  const thread = await bridge.createThread({ environmentId: localEnv.id });
  return { thread };
}

// Merges a freshly-created thread (and optionally its new worktree
// environment) into the local snapshot so UI that depends on snapshot lookup
// (pane resolution, sidebar, etc.) sees it immediately. The next successful
// `refreshSnapshot` call will overwrite this with the backend's canonical
// view; this is only a stopgap so the user is not blocked when a refresh
// fails transiently.
function mergeCreatedThreadIntoSnapshot(
  projectId: string,
  thread: ThreadRecord,
  environment: EnvironmentRecord | undefined,
): void {
  useWorkspaceStore.setState((state) => {
    if (!state.snapshot) return state;
    const nextProjects = state.snapshot.projects.map((project) => {
      if (project.id !== projectId) return project;
      let environments = project.environments;
      if (
        environment &&
        !environments.some((candidate) => candidate.id === environment.id)
      ) {
        environments = [...environments, environment];
      }
      environments = environments.map((env) => {
        if (env.id !== thread.environmentId) return env;
        if (env.threads.some((candidate) => candidate.id === thread.id)) {
          return env;
        }
        return { ...env, threads: [...env.threads, thread] };
      });
      return { ...project, environments };
    });
    return { snapshot: { ...state.snapshot, projects: nextProjects } };
  });
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
