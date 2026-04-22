import {
  CODEX_USAGE_EVENT_NAMES,
  CONVERSATION_EVENT_NAMES,
  FIRST_PROMPT_RENAME_FAILURE_EVENT_NAMES,
  MENU_CHECK_FOR_UPDATES_EVENT_NAMES,
  MENU_OPEN_SETTINGS_EVENT_NAMES,
  PROJECT_ACTION_STATE_EVENT_NAMES,
  TERMINAL_EXIT_EVENT_NAMES,
  TERMINAL_OUTPUT_EVENT_NAMES,
  WORKSPACE_EVENT_NAMES,
  WORKTREE_SCRIPT_FAILURE_EVENT_NAMES,
} from "./app-identity";
import type {
  AddProjectRequest,
  ArchiveThreadRequest,
  BootstrapStatus,
  ChatThreadCreateResult,
  CommitGitInput,
  ComposerFileSearchResult,
  ComposerTarget,
  CodexRateLimitSnapshot,
  CodexUsageEventPayload,
  ConversationEventPayload,
  CreateThreadRequest,
  DraftThreadTarget,
  EnvironmentCapabilitiesSnapshot,
  GitFileDiff,
  GitFileDiffInput,
  GitFileInput,
  GitReviewSnapshot,
  GitRevertFileInput,
  GitScopeInput,
  GlobalSettings,
  GlobalSettingsPatch,
  ManagedWorktreeCreateResult,
  EnvironmentVoiceStatusSnapshot,
  FirstPromptRenameFailureEventPayload,
  OpenEnvironmentInput,
  PersistThreadComposerDraftInput,
  ProjectActionStateEventPayload,
  ProjectRecord,
  ReorderProjectsRequest,
  RunProjectActionRequest,
  RunProjectActionResult,
  ShortcutSettings,
  UpdateProjectSettingsRequest,
  RespondToApprovalRequestInput,
  RespondToUserInputRequestInput,
  RenameProjectRequest,
  RenameThreadRequest,
  RuntimeStatusSnapshot,
  SaveDraftThreadStateInput,
  SendThreadMessageInput,
  SavedDraftThreadState,
  SetProjectSidebarCollapsedRequest,
  SubmitPlanDecisionInput,
  TranscribeEnvironmentVoiceInput,
  ThreadComposerCatalog,
  ThreadConversationOpenResponse,
  ThreadConversationSnapshot,
  ThreadRecord,
  WorktreeScriptFailureEventPayload,
  WorkspaceEventPayload,
  VoiceTranscriptionResult,
  WorkspaceSnapshot,
} from "./types";
import {
  invokeCommand as invoke,
  listenEvent as listen,
  type HostUnlistenFn as UnlistenFn,
} from "./desktop-host";

export function getBootstrapStatus(): Promise<BootstrapStatus> {
  return invoke<BootstrapStatus>("get_bootstrap_status");
}

export function getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  return invoke<WorkspaceSnapshot>("get_workspace_snapshot");
}

export function getDraftThreadState(
  target: DraftThreadTarget,
): Promise<SavedDraftThreadState | null> {
  return invoke<SavedDraftThreadState | null>("get_draft_thread_state", {
    target,
  });
}

export function saveDraftThreadState(
  input: SaveDraftThreadStateInput,
): Promise<void> {
  return invoke<void>("save_draft_thread_state", { input });
}

export function getShortcutDefaults(): Promise<ShortcutSettings> {
  return invoke<ShortcutSettings>("get_shortcut_defaults");
}

export function getGitReviewSnapshot(
  input: GitScopeInput,
): Promise<GitReviewSnapshot> {
  return invoke<GitReviewSnapshot>("get_git_review_snapshot", { input });
}

export function getGitFileDiff(
  input: GitFileDiffInput,
): Promise<GitFileDiff> {
  return invoke<GitFileDiff>("get_git_file_diff", { input });
}

export function stageGitFile(
  input: GitFileInput,
): Promise<GitReviewSnapshot> {
  return invoke<GitReviewSnapshot>("stage_git_file", { input });
}

export function stageGitAll(
  input: GitScopeInput,
): Promise<GitReviewSnapshot> {
  return invoke<GitReviewSnapshot>("stage_git_all", { input });
}

export function unstageGitFile(
  input: GitFileInput,
): Promise<GitReviewSnapshot> {
  return invoke<GitReviewSnapshot>("unstage_git_file", { input });
}

export function unstageGitAll(
  input: GitScopeInput,
): Promise<GitReviewSnapshot> {
  return invoke<GitReviewSnapshot>("unstage_git_all", { input });
}

export function revertGitFile(
  input: GitRevertFileInput,
): Promise<GitReviewSnapshot> {
  return invoke<GitReviewSnapshot>("revert_git_file", { input });
}

export function revertGitAll(
  input: GitScopeInput,
): Promise<GitReviewSnapshot> {
  return invoke<GitReviewSnapshot>("revert_git_all", { input });
}

export function commitGit(
  input: CommitGitInput,
): Promise<GitReviewSnapshot> {
  return invoke<GitReviewSnapshot>("commit_git", { input });
}

export function fetchGit(
  input: GitScopeInput,
): Promise<GitReviewSnapshot> {
  return invoke<GitReviewSnapshot>("fetch_git", { input });
}

export function pullGit(
  input: GitScopeInput,
): Promise<GitReviewSnapshot> {
  return invoke<GitReviewSnapshot>("pull_git", { input });
}

export function pushGit(
  input: GitScopeInput,
): Promise<GitReviewSnapshot> {
  return invoke<GitReviewSnapshot>("push_git", { input });
}

export function generateGitCommitMessage(
  environmentId: string,
): Promise<string> {
  return invoke<string>("generate_git_commit_message", { environmentId });
}

export function openThreadConversation(
  threadId: string,
): Promise<ThreadConversationOpenResponse> {
  return invoke<ThreadConversationOpenResponse>("open_thread_conversation", {
    threadId,
  });
}

export function saveThreadComposerDraft(
  input: PersistThreadComposerDraftInput,
): Promise<void> {
  return invoke<void>("save_thread_composer_draft", { input });
}

export function refreshThreadConversation(
  threadId: string,
): Promise<ThreadConversationSnapshot> {
  return invoke<ThreadConversationSnapshot>("refresh_thread_conversation", {
    threadId,
  });
}

export function getComposerCatalog(
  target: ComposerTarget,
): Promise<ThreadComposerCatalog> {
  return invoke<ThreadComposerCatalog>("get_composer_catalog", {
    target,
  });
}

export function searchComposerFiles(input: {
  target: ComposerTarget;
  requestKey: string;
  query: string;
  limit?: number;
}): Promise<ComposerFileSearchResult[]> {
  return invoke<ComposerFileSearchResult[]>("search_composer_files", { input });
}

export function sendThreadMessage(
  input: SendThreadMessageInput,
): Promise<ThreadConversationSnapshot> {
  return invoke<ThreadConversationSnapshot>("send_thread_message", { input });
}

export function readImageAsDataUrl(path: string): Promise<string> {
  return invoke<string>("read_image_as_data_url", { path });
}

export function interruptThreadTurn(
  threadId: string,
): Promise<ThreadConversationSnapshot> {
  return invoke<ThreadConversationSnapshot>("interrupt_thread_turn", {
    threadId,
  });
}

export function respondToApprovalRequest(
  input: RespondToApprovalRequestInput,
): Promise<ThreadConversationSnapshot> {
  return invoke<ThreadConversationSnapshot>("respond_to_approval_request", { input });
}

export function respondToUserInputRequest(
  input: RespondToUserInputRequestInput,
): Promise<ThreadConversationSnapshot> {
  return invoke<ThreadConversationSnapshot>("respond_to_user_input_request", { input });
}

export function submitPlanDecision(
  input: SubmitPlanDecisionInput,
): Promise<ThreadConversationSnapshot> {
  return invoke<ThreadConversationSnapshot>("submit_plan_decision", { input });
}

export function listenToConversationEvents(
  callback: (payload: ConversationEventPayload) => void,
): Promise<UnlistenFn> {
  return listenToPayloadEvents(CONVERSATION_EVENT_NAMES, callback);
}

export function getEnvironmentCodexRateLimits(
  environmentId: string,
): Promise<CodexRateLimitSnapshot> {
  return invoke<CodexRateLimitSnapshot>("get_environment_codex_rate_limits", {
    environmentId,
  });
}

export function getEnvironmentCapabilities(
  environmentId: string,
): Promise<EnvironmentCapabilitiesSnapshot> {
  return invoke<EnvironmentCapabilitiesSnapshot>("get_environment_capabilities", {
    environmentId,
  });
}

export function getEnvironmentVoiceStatus(
  environmentId: string,
): Promise<EnvironmentVoiceStatusSnapshot> {
  return invoke<EnvironmentVoiceStatusSnapshot>("get_environment_voice_status", {
    environmentId,
  });
}

export function transcribeEnvironmentVoice(
  input: TranscribeEnvironmentVoiceInput,
): Promise<VoiceTranscriptionResult> {
  return invoke<VoiceTranscriptionResult>("transcribe_environment_voice", { input });
}

export function listenToCodexUsageEvents(
  callback: (payload: CodexUsageEventPayload) => void,
): Promise<UnlistenFn> {
  return listenToPayloadEvents(CODEX_USAGE_EVENT_NAMES, callback);
}

export function listenToWorktreeScriptFailures(
  callback: (payload: WorktreeScriptFailureEventPayload) => void,
): Promise<UnlistenFn> {
  return listenToPayloadEvents(WORKTREE_SCRIPT_FAILURE_EVENT_NAMES, callback);
}

export function listenToFirstPromptRenameFailures(
  callback: (payload: FirstPromptRenameFailureEventPayload) => void,
): Promise<UnlistenFn> {
  return listenToPayloadEvents(
    FIRST_PROMPT_RENAME_FAILURE_EVENT_NAMES,
    callback,
  );
}

export function listenToWorkspaceEvents(
  callback: (payload: WorkspaceEventPayload) => void,
): Promise<UnlistenFn> {
  return listenToPayloadEvents(WORKSPACE_EVENT_NAMES, callback);
}

export function listenToMenuOpenSettings(
  callback: () => void,
): Promise<UnlistenFn> {
  return listenToSignalEvents(MENU_OPEN_SETTINGS_EVENT_NAMES, callback);
}

export function listenToMenuCheckForUpdates(
  callback: () => void,
): Promise<UnlistenFn> {
  return listenToSignalEvents(MENU_CHECK_FOR_UPDATES_EVENT_NAMES, callback);
}

export function updateGlobalSettings(
  patch: GlobalSettingsPatch,
): Promise<GlobalSettings> {
  return invoke<GlobalSettings>("update_global_settings", { patch });
}

export function openEnvironment(
  input: OpenEnvironmentInput,
): Promise<void> {
  return invoke<void>("open_environment", { input });
}

export function addProject(
  input: AddProjectRequest,
): Promise<ProjectRecord> {
  return invoke<ProjectRecord>("add_project", { input });
}

export function renameProject(
  input: RenameProjectRequest,
): Promise<ProjectRecord> {
  return invoke<ProjectRecord>("rename_project", { input });
}

export function updateProjectSettings(
  input: UpdateProjectSettingsRequest,
): Promise<ProjectRecord> {
  return invoke<ProjectRecord>("update_project_settings", { input });
}

export function runProjectAction(
  input: RunProjectActionRequest,
): Promise<RunProjectActionResult> {
  return invoke<RunProjectActionResult>("run_project_action", { input });
}

export function reorderProjects(
  input: ReorderProjectsRequest,
): Promise<void> {
  return invoke<void>("reorder_projects", { input });
}

export function setProjectSidebarCollapsed(
  input: SetProjectSidebarCollapsedRequest,
): Promise<void> {
  return invoke<void>("set_project_sidebar_collapsed", { input });
}

export function ensureProjectCanBeRemoved(projectId: string): Promise<void> {
  return invoke<void>("ensure_project_can_be_removed", { projectId });
}

export function removeProject(projectId: string): Promise<void> {
  return invoke<void>("remove_project", { projectId });
}

export type CreateManagedWorktreeOptions = {
  baseBranch?: string;
  name?: string;
  overrides?: ThreadRecord["overrides"];
};

export function createManagedWorktree(
  projectId: string,
  options?: CreateManagedWorktreeOptions,
): Promise<ManagedWorktreeCreateResult> {
  const input: Record<string, unknown> = { projectId };
  if (options?.baseBranch !== undefined) input.baseBranch = options.baseBranch;
  if (options?.name !== undefined) input.name = options.name;
  if (options?.overrides !== undefined) input.overrides = options.overrides;
  return invoke<ManagedWorktreeCreateResult>("create_managed_worktree", {
    input,
  });
}

export function listProjectBranches(projectId: string): Promise<string[]> {
  return invoke<string[]>("list_project_branches", { projectId });
}

export function deleteWorktreeEnvironment(
  environmentId: string,
): Promise<void> {
  return invoke<void>("delete_worktree_environment", { environmentId });
}

export function createThread(
  input: CreateThreadRequest,
): Promise<ThreadRecord> {
  return invoke<ThreadRecord>("create_thread", { input });
}

export function createChatThread(input: {
  title?: string;
  overrides?: ThreadRecord["overrides"];
}): Promise<ChatThreadCreateResult> {
  return invoke<ChatThreadCreateResult>("create_chat_thread", { input });
}

export function renameThread(
  input: RenameThreadRequest,
): Promise<ThreadRecord> {
  return invoke<ThreadRecord>("rename_thread", { input });
}

export function archiveThread(
  input: ArchiveThreadRequest,
): Promise<ThreadRecord> {
  return invoke<ThreadRecord>("archive_thread", { input });
}

export function startEnvironmentRuntime(
  environmentId: string,
): Promise<RuntimeStatusSnapshot> {
  return invoke<RuntimeStatusSnapshot>("start_environment_runtime", {
    environmentId,
  });
}

export function stopEnvironmentRuntime(
  environmentId: string,
): Promise<RuntimeStatusSnapshot> {
  return invoke<RuntimeStatusSnapshot>("stop_environment_runtime", {
    environmentId,
  });
}

export function touchEnvironmentRuntime(
  environmentId: string,
): Promise<boolean> {
  return invoke<boolean>("touch_environment_runtime", {
    environmentId,
  });
}

export function getProjectIcon(
  rootPath: string,
): Promise<string | null> {
  return invoke<string | null>("get_project_icon", { rootPath });
}

export function restartApp(): Promise<void> {
  return invoke<void>("restart_app");
}

/* ── Terminal ── */

export type TerminalSpawnInput = {
  environmentId: string;
  cols: number;
  rows: number;
};
export type TerminalSpawnResult = { ptyId: string; cwd: string };
export type TerminalWriteInput = { ptyId: string; dataBase64: string };
export type TerminalResizeInput = { ptyId: string; cols: number; rows: number };
export type TerminalKillInput = { ptyId: string };
export type TerminalOutputPayload = { ptyId: string; dataBase64: string };
export type TerminalExitPayload = { ptyId: string; exitCode: number | null };

export function spawnTerminal(
  input: TerminalSpawnInput,
): Promise<TerminalSpawnResult> {
  return invoke<TerminalSpawnResult>("terminal_spawn", { input });
}

export function writeTerminal(input: TerminalWriteInput): Promise<void> {
  return invoke<void>("terminal_write", { input });
}

export function resizeTerminal(input: TerminalResizeInput): Promise<void> {
  return invoke<void>("terminal_resize", { input });
}

export function killTerminal(input: TerminalKillInput): Promise<void> {
  return invoke<void>("terminal_kill", { input });
}

export function listenToTerminalOutput(
  callback: (payload: TerminalOutputPayload) => void,
): Promise<UnlistenFn> {
  return listenToPayloadEvents(TERMINAL_OUTPUT_EVENT_NAMES, callback);
}

export function listenToTerminalExit(
  callback: (payload: TerminalExitPayload) => void,
): Promise<UnlistenFn> {
  return listenToPayloadEvents(TERMINAL_EXIT_EVENT_NAMES, callback);
}

export function listenToProjectActionState(
  callback: (payload: ProjectActionStateEventPayload) => void,
): Promise<UnlistenFn> {
  return listenToPayloadEvents(PROJECT_ACTION_STATE_EVENT_NAMES, callback);
}

async function listenToPayloadEvents<T>(
  eventNames: readonly string[],
  callback: (payload: T) => void,
): Promise<UnlistenFn> {
  return listenWithLegacyFallback<T>(eventNames, (_eventName, event) => {
    callback(event.payload as T);
  });
}

async function listenToSignalEvents(
  eventNames: readonly string[],
  callback: () => void,
): Promise<UnlistenFn> {
  return listenWithLegacyFallback(eventNames, () => callback());
}

async function listenWithLegacyFallback<T>(
  eventNames: readonly string[],
  onEvent: (
    eventName: string,
    event: {
      payload: T;
    },
  ) => void,
): Promise<UnlistenFn> {
  let disposed = false;
  let activeEventName: string | null = null;
  const unlisteners = new Map<string, UnlistenFn>();

  function pruneInactiveListeners(selectedEventName: string) {
    for (const [registeredEventName, unlisten] of unlisteners) {
      if (registeredEventName === selectedEventName) {
        continue;
      }
      unlisten();
      unlisteners.delete(registeredEventName);
    }
  }

  // Keep the listener namespace compatible during the legacy -> Skein rollout,
  // but commit to the first namespace that actually emits to avoid double
  // processing if both old and new events are present briefly.
  try {
    await Promise.all(
      eventNames.map(async (eventName) => {
        const unlisten = await listen<T>(eventName, (event) => {
          if (disposed) {
            return;
          }
          if (activeEventName && activeEventName !== eventName) {
            return;
          }
          if (!activeEventName) {
            activeEventName = eventName;
            pruneInactiveListeners(eventName);
          }
          onEvent(eventName, event);
        });

        if (disposed || (activeEventName && activeEventName !== eventName)) {
          unlisten();
          return;
        }

        unlisteners.set(eventName, unlisten);
      }),
    );
  } catch (error) {
    disposed = true;
    for (const unlisten of unlisteners.values()) {
      unlisten();
    }
    unlisteners.clear();
    throw error;
  }

  return () => {
    disposed = true;
    for (const unlisten of unlisteners.values()) {
      unlisten();
    }
    unlisteners.clear();
  };
}
