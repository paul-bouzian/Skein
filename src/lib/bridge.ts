import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AddProjectRequest,
  ArchiveThreadRequest,
  BootstrapStatus,
  CommitGitInput,
  ComposerFileSearchResult,
  CodexRateLimitSnapshot,
  CodexUsageEventPayload,
  ConversationEventPayload,
  CreateThreadRequest,
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
  ProjectRecord,
  UpdateProjectSettingsRequest,
  RespondToApprovalRequestInput,
  RespondToUserInputRequestInput,
  RenameProjectRequest,
  RenameThreadRequest,
  RuntimeStatusSnapshot,
  SendThreadMessageInput,
  SubmitPlanDecisionInput,
  TranscribeEnvironmentVoiceInput,
  ThreadComposerCatalog,
  ThreadConversationOpenResponse,
  ThreadConversationSnapshot,
  ThreadRecord,
  WorktreeScriptFailureEventPayload,
  VoiceTranscriptionResult,
  WorkspaceSnapshot,
} from "./types";

export function getBootstrapStatus(): Promise<BootstrapStatus> {
  return invoke<BootstrapStatus>("get_bootstrap_status");
}

export function getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  return invoke<WorkspaceSnapshot>("get_workspace_snapshot");
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

export function refreshThreadConversation(
  threadId: string,
): Promise<ThreadConversationSnapshot> {
  return invoke<ThreadConversationSnapshot>("refresh_thread_conversation", {
    threadId,
  });
}

export function getThreadComposerCatalog(
  threadId: string,
): Promise<ThreadComposerCatalog> {
  return invoke<ThreadComposerCatalog>("get_thread_composer_catalog", {
    threadId,
  });
}

export function searchThreadFiles(input: {
  threadId: string;
  query: string;
  limit?: number;
}): Promise<ComposerFileSearchResult[]> {
  return invoke<ComposerFileSearchResult[]>("search_thread_files", { input });
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
  return listen<ConversationEventPayload>(
    "threadex://conversation-event",
    (event) => callback(event.payload),
  );
}

export function getEnvironmentCodexRateLimits(
  environmentId: string,
): Promise<CodexRateLimitSnapshot> {
  return invoke<CodexRateLimitSnapshot>("get_environment_codex_rate_limits", {
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
  return listen<CodexUsageEventPayload>(
    "threadex://codex-usage-event",
    (event) => callback(event.payload),
  );
}

export function listenToWorktreeScriptFailures(
  callback: (payload: WorktreeScriptFailureEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<WorktreeScriptFailureEventPayload>(
    "threadex://worktree-script-failure",
    (event) => callback(event.payload),
  );
}

export function updateGlobalSettings(
  patch: GlobalSettingsPatch,
): Promise<GlobalSettings> {
  return invoke<GlobalSettings>("update_global_settings", { patch });
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

export function ensureProjectCanBeRemoved(projectId: string): Promise<void> {
  return invoke<void>("ensure_project_can_be_removed", { projectId });
}

export function removeProject(projectId: string): Promise<void> {
  return invoke<void>("remove_project", { projectId });
}

export function createManagedWorktree(
  projectId: string,
): Promise<ManagedWorktreeCreateResult> {
  return invoke<ManagedWorktreeCreateResult>("create_managed_worktree", { projectId });
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
  return listen<TerminalOutputPayload>(
    "threadex://terminal-output",
    (event) => callback(event.payload),
  );
}

export function listenToTerminalExit(
  callback: (payload: TerminalExitPayload) => void,
): Promise<UnlistenFn> {
  return listen<TerminalExitPayload>(
    "threadex://terminal-exit",
    (event) => callback(event.payload),
  );
}
