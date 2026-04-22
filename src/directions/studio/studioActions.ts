import * as bridge from "../../lib/bridge";
import { dialog } from "../../lib/shell";
import type {
  ComposerMentionBindingInput,
  ConversationComposerDraft,
  ConversationComposerSettings,
  ConversationImageAttachment,
  EnvironmentRecord,
  SavedDraftThreadState,
  ThreadRecord,
  WorkspaceSnapshot,
} from "../../lib/types";
import { useConversationStore } from "../../stores/conversation-store";
import { useVoiceSessionStore } from "../../stores/voice-session-store";
import {
  findThreadInWorkspace,
  selectSelectedEnvironment,
  useWorkspaceStore,
  type SlotKey,
  type ThreadDraftState,
} from "../../stores/workspace-store";
import type { EnvSelection } from "./draft/EnvironmentSelector";

export async function createThreadForSelection() {
  const environment = selectedEnvironment();
  if (!environment) {
    return false;
  }
  if (environment.kind === "chat") {
    return openChatDraft() !== null;
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

export function openChatDraft(slot?: SlotKey): SlotKey | null {
  return useWorkspaceStore.getState().openChatDraft(slot);
}

export type SendThreadDraftInput = {
  paneId: SlotKey;
  draft: ThreadDraftState;
  persistedState: SavedDraftThreadState;
  projectSelection: EnvSelection;
  text: string;
  images?: ConversationImageAttachment[];
  mentionBindings?: ComposerMentionBindingInput[];
  draftMentionBindings?: ConversationComposerDraft["mentionBindings"];
};

export type SendThreadDraftResult =
  | { ok: true; thread: ThreadRecord }
  | { ok: false; error: string };

export async function sendThreadDraft(
  input: SendThreadDraftInput,
): Promise<SendThreadDraftResult> {
  const { paneId, draft, persistedState, projectSelection, text } = input;
  const images = input.images ?? [];
  const mentionBindings = input.mentionBindings ?? [];
  const draftMentionBindings =
    input.draftMentionBindings ?? persistedState.composerDraft.mentionBindings;
  const composer = persistedState.composer;
  const defaultServiceTier =
    useWorkspaceStore.getState().snapshot?.settings.defaultServiceTier ?? null;
  if (text.trim().length === 0 && images.length === 0) {
    return { ok: false, error: "Message is empty" };
  }

  let resolved: ResolvedDraftThread;
  try {
    resolved = await resolveDraftThread(
      draft,
      projectSelection,
      threadOverridesFromComposer(composer, defaultServiceTier),
    );
  } catch (cause: unknown) {
    return {
      ok: false,
      error: extractErrorMessage(cause) ?? "Failed to create thread",
    };
  }
  const { thread, environment } = resolved;
  const projectId =
    environment?.projectId ??
    (draft.kind === "project"
      ? draft.projectId
      : (useWorkspaceStore.getState().snapshot?.chat.projectId ?? null));
  if (!projectId) {
    return { ok: false, error: "Failed to resolve the draft destination." };
  }

  const transferredDraft = normalizeTransferredComposerDraft(
    persistedState.composerDraft,
    {
      text,
      images,
      mentionBindings: draftMentionBindings,
    },
  );
  let transferredDraftPersisted = true;
  try {
    await bridge.saveThreadComposerDraft({
      threadId: thread.id,
      draft: transferredDraft,
    });
  } catch {
    transferredDraftPersisted = false;
  }

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
  useConversationStore.setState((state) => ({
    composerByThreadId: {
      ...state.composerByThreadId,
      [thread.id]: composer,
    },
    ...(transferredDraftPersisted
      ? {}
      : {
          draftByThreadId: {
            ...state.draftByThreadId,
            [thread.id]: transferredDraft,
          },
        }),
  }));

  // Hand the message off to ThreadConversation: it consumes the pending
  // first message on mount and runs its own handleSend, which already wires
  // up the optimistic user message and the FirstPromptNamingNotice spinner.
  useConversationStore.getState().enqueuePendingFirstMessage(thread.id, {
    text: text.trim(),
    images,
    mentionBindings,
    composer,
  });

  useWorkspaceStore.getState().clearDraftThreadState(draft);

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
  // Populated for chat creation and "new worktree" flows, where the backend
  // returns the freshly-created environment alongside the thread.
  environment?: EnvironmentRecord;
};

async function resolveDraftThread(
  draft: ThreadDraftState,
  projectSelection: EnvSelection,
  overrides: ThreadRecord["overrides"],
): Promise<ResolvedDraftThread> {
  if (draft.kind === "chat") {
    const result = await bridge.createChatThread({ overrides });
    return { thread: result.thread, environment: result.environment };
  }

  if (projectSelection.kind === "new") {
    const trimmedName = projectSelection.name.trim();
    const baseBranch = projectSelection.baseBranch.trim();
    const result = await bridge.createManagedWorktree(draft.projectId, {
      // Leaving baseBranch empty lets the backend fall back to
      // resolve_base_reference (remote/upstream), which is how the legacy
      // standalone flow worked and matters for detached-HEAD repos.
      ...(baseBranch.length > 0 ? { baseBranch } : {}),
      ...(trimmedName.length > 0 ? { name: trimmedName } : {}),
      overrides,
    });
    return { thread: result.thread, environment: result.environment };
  }

  if (projectSelection.kind === "existing") {
    const thread = await bridge.createThread({
      environmentId: projectSelection.environmentId,
      overrides,
    });
    return { thread };
  }

  const localEnv = findLocalEnvironment(draft.projectId);
  if (!localEnv) {
    throw new Error("No local environment found for this project.");
  }
  const thread = await bridge.createThread({
    environmentId: localEnv.id,
    overrides,
  });
  return { thread };
}

function threadOverridesFromComposer(
  composer: ConversationComposerSettings,
  defaultServiceTier: ConversationComposerSettings["serviceTier"],
): ThreadRecord["overrides"] {
  return {
    model: composer.model,
    reasoningEffort: composer.reasoningEffort,
    collaborationMode: composer.collaborationMode,
    approvalPolicy: composer.approvalPolicy,
    serviceTier: composer.serviceTier,
    serviceTierOverridden: composer.serviceTier !== defaultServiceTier,
  };
}

function normalizeTransferredComposerDraft(
  composerDraft: ConversationComposerDraft,
  overrides?: {
    text: string;
    images: ConversationImageAttachment[];
    mentionBindings: ConversationComposerDraft["mentionBindings"];
  },
): ConversationComposerDraft {
  return {
    text: overrides?.text ?? composerDraft.text,
    images: [...(overrides?.images ?? composerDraft.images)],
    mentionBindings: [
      ...(overrides?.mentionBindings ?? composerDraft.mentionBindings),
    ],
    isRefiningPlan: composerDraft.isRefiningPlan,
  };
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
    if (projectId === state.snapshot.chat.projectId) {
      let environments = state.snapshot.chat.environments;
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
      return {
        snapshot: {
          ...state.snapshot,
          chat: {
            ...state.snapshot.chat,
            environments,
          },
        },
      };
    }
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

function extractErrorMessage(cause: unknown): string | null {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    const message = cause.message.trim();
    return message.length > 0 ? message : null;
  }

  if (cause instanceof Error) {
    const message = cause.message.trim();
    return message.length > 0 ? message : null;
  }

  return null;
}

export async function archiveThreadWithConfirmation(threadId: string) {
  const snapshot = useWorkspaceStore.getState().snapshot;
  const target = findThreadInWorkspace(snapshot, threadId);
  if (!target || ownsPendingVoiceWork(threadId)) {
    return false;
  }

  const willEmptyWorktree = isLastActiveWorktreeThread(
    target.environment,
    threadId,
  );
  const dialogPrompt = willEmptyWorktree
    ? `This is the last active thread in the worktree "${target.environment.name}". Archiving it will also delete the worktree.\n\nContinue?`
    : "Are you sure you want to archive this thread?";
  const dialogTitle = willEmptyWorktree
    ? "Archive thread & delete worktree"
    : "Archive Thread";
  const dialogOkLabel = willEmptyWorktree ? "Archive & delete" : "Archive";

  const confirmed = await dialog.confirm(dialogPrompt, {
    title: dialogTitle,
    kind: "warning",
    okLabel: dialogOkLabel,
    cancelLabel: "Cancel",
  });
  if (!confirmed) {
    return false;
  }

  const latestSnapshot = useWorkspaceStore.getState().snapshot;
  const latestTarget = findThreadInWorkspace(latestSnapshot, threadId);
  if (!latestTarget || ownsPendingVoiceWork(threadId)) {
    return false;
  }

  const archivedEnvironmentId = latestTarget.environment.id;
  const wantsWorktreeDeletion =
    willEmptyWorktree &&
    isLastActiveWorktreeThread(latestTarget.environment, threadId);

  await bridge.archiveThread({ threadId: latestTarget.thread.id });
  useWorkspaceStore.getState().removeThread(latestTarget.thread.id);
  const refreshed = await useWorkspaceStore.getState().refreshSnapshot();

  if (refreshed && wantsWorktreeDeletion) {
    // Re-check against the refreshed snapshot: a concurrent thread creation
    // could have repopulated the environment while we awaited the archive.
    const refreshedEnv = findEnvironmentInWorkspace(
      useWorkspaceStore.getState().snapshot,
      archivedEnvironmentId,
    );
    if (refreshedEnv && environmentHasNoActiveThreads(refreshedEnv)) {
      await deleteEmptyWorktreeQuietly(archivedEnvironmentId);
    }
  }

  return refreshed;
}

function isLastActiveWorktreeThread(
  environment: EnvironmentRecord,
  archivedThreadId: string,
) {
  if (environment.kind === "local" || environment.kind === "chat") return false;
  const remainingActive = environment.threads.filter(
    (thread) => thread.status === "active" && thread.id !== archivedThreadId,
  );
  return remainingActive.length === 0;
}

function environmentHasNoActiveThreads(environment: EnvironmentRecord) {
  if (environment.kind === "local" || environment.kind === "chat") return false;
  return !environment.threads.some((thread) => thread.status === "active");
}

function findEnvironmentInWorkspace(
  snapshot: WorkspaceSnapshot | null,
  environmentId: string,
): EnvironmentRecord | null {
  if (!snapshot) return null;
  for (const project of snapshot.projects) {
    const match = project.environments.find(
      (environment) => environment.id === environmentId,
    );
    if (match) return match;
  }
  return null;
}

async function deleteEmptyWorktreeQuietly(environmentId: string) {
  try {
    await bridge.deleteWorktreeEnvironment(environmentId);
    await useWorkspaceStore.getState().refreshSnapshot();
  } catch {
    // Swallowing the error here keeps the archive flow clean. The worktree
    // remains, but the user already confirmed archival; surfacing a second
    // error dialog would be more confusing than retrying from elsewhere.
  }
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
  return selectSelectedEnvironment(useWorkspaceStore.getState());
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
