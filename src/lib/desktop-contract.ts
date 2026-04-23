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
import { isLoopbackHost } from "./browser-preview";

export const DESKTOP_BACKEND_COMMANDS = [
  "add_project",
  "archive_thread",
  "commit_git",
  "create_chat_thread",
  "create_managed_worktree",
  "create_thread",
  "delete_worktree_environment",
  "ensure_project_can_be_removed",
  "fetch_git",
  "generate_git_commit_message",
  "get_bootstrap_status",
  "get_composer_catalog",
  "get_draft_thread_state",
  "get_environment_capabilities",
  "get_environment_codex_rate_limits",
  "get_environment_voice_status",
  "get_git_file_diff",
  "get_git_review_snapshot",
  "get_project_icon",
  "get_shortcut_defaults",
  "get_workspace_snapshot",
  "interrupt_thread_turn",
  "list_project_branches",
  "open_environment",
  "open_thread_conversation",
  "pull_git",
  "push_git",
  "read_image_as_data_url",
  "refresh_thread_conversation",
  "remove_project",
  "rename_project",
  "rename_thread",
  "reorder_projects",
  "respond_to_approval_request",
  "respond_to_user_input_request",
  "restart_app",
  "revert_git_all",
  "revert_git_file",
  "run_project_action",
  "save_draft_thread_state",
  "save_thread_composer_draft",
  "search_composer_files",
  "send_thread_message",
  "set_project_sidebar_collapsed",
  "stage_git_all",
  "stage_git_file",
  "start_environment_runtime",
  "stop_environment_runtime",
  "submit_plan_decision",
  "terminal_kill",
  "terminal_resize",
  "terminal_spawn",
  "terminal_write",
  "touch_environment_runtime",
  "transcribe_environment_voice",
  "unstage_git_all",
  "unstage_git_file",
  "update_global_settings",
  "update_project_settings",
] as const;

export type DesktopBackendCommand = (typeof DESKTOP_BACKEND_COMMANDS)[number];

export const DESKTOP_EVENT_NAMES = [
  ...CONVERSATION_EVENT_NAMES,
  ...CODEX_USAGE_EVENT_NAMES,
  ...WORKTREE_SCRIPT_FAILURE_EVENT_NAMES,
  ...FIRST_PROMPT_RENAME_FAILURE_EVENT_NAMES,
  ...WORKSPACE_EVENT_NAMES,
  ...TERMINAL_OUTPUT_EVENT_NAMES,
  ...TERMINAL_EXIT_EVENT_NAMES,
  ...PROJECT_ACTION_STATE_EVENT_NAMES,
  ...MENU_OPEN_SETTINGS_EVENT_NAMES,
  ...MENU_CHECK_FOR_UPDATES_EVENT_NAMES,
] as const;

export type DesktopEventName = (typeof DESKTOP_EVENT_NAMES)[number];

const BACKEND_COMMAND_SET = new Set<string>(DESKTOP_BACKEND_COMMANDS);
const EVENT_NAME_SET = new Set<string>(DESKTOP_EVENT_NAMES);
const OPEN_EXTERNAL_PROTOCOLS = new Set(["https:", "mailto:"]);

export function assertDesktopBackendCommand(
  command: string,
): DesktopBackendCommand {
  if (!BACKEND_COMMAND_SET.has(command)) {
    throw new Error(`Unsupported desktop command: ${command}`);
  }

  return command as DesktopBackendCommand;
}

export function assertDesktopEventName(eventName: string): DesktopEventName {
  if (!EVENT_NAME_SET.has(eventName)) {
    throw new Error(`Unsupported desktop event: ${eventName}`);
  }

  return eventName as DesktopEventName;
}

export function assertDesktopPayload(
  payload: unknown,
): Record<string, unknown> | undefined {
  if (payload === undefined) {
    return undefined;
  }

  if (!isPlainObject(payload)) {
    throw new Error("Desktop payload must be a plain object.");
  }

  return payload;
}

export function assertOpenExternalUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("External URL must be an absolute URL.");
  }

  if (OPEN_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    return parsed.toString();
  }

  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
    return parsed.toString();
  }

  throw new Error(
    "Only https URLs, mailto links, and loopback http URLs can be opened externally.",
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
