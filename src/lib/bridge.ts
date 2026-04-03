import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AddProjectRequest,
  ArchiveThreadRequest,
  BootstrapStatus,
  ConversationEventPayload,
  CreateThreadRequest,
  CreateWorktreeRequest,
  EnvironmentRecord,
  GlobalSettings,
  GlobalSettingsPatch,
  ProjectRecord,
  RespondToApprovalRequestInput,
  RespondToUserInputRequestInput,
  RenameProjectRequest,
  RenameThreadRequest,
  RuntimeStatusSnapshot,
  SendThreadMessageInput,
  SubmitPlanDecisionInput,
  ThreadConversationOpenResponse,
  ThreadConversationSnapshot,
  ThreadRecord,
  WorkspaceSnapshot,
} from "./types";

export function getBootstrapStatus(): Promise<BootstrapStatus> {
  return invoke<BootstrapStatus>("get_bootstrap_status");
}

export function getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  return invoke<WorkspaceSnapshot>("get_workspace_snapshot");
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

export function sendThreadMessage(
  input: SendThreadMessageInput,
): Promise<ThreadConversationSnapshot> {
  return invoke<ThreadConversationSnapshot>("send_thread_message", { input });
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

export function removeProject(projectId: string): Promise<void> {
  return invoke<void>("remove_project", { projectId });
}

export function createWorktreeEnvironment(
  input: CreateWorktreeRequest,
): Promise<EnvironmentRecord> {
  return invoke<EnvironmentRecord>("create_worktree_environment", { input });
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
