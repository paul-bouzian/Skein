export const APP_NAME = "Loom";
export const APP_SLUG = "loom";
export const LEGACY_APP_NAME = "ThreadEx";
export const LEGACY_APP_SLUG = "threadex";

export const CONVERSATION_EVENT_NAME = "loom://conversation-event";
export const CODEX_USAGE_EVENT_NAME = "loom://codex-usage-event";
export const WORKTREE_SCRIPT_FAILURE_EVENT_NAME = "loom://worktree-script-failure";
export const WORKSPACE_EVENT_NAME = "loom://workspace-event";
export const TERMINAL_OUTPUT_EVENT_NAME = "loom://terminal-output";
export const TERMINAL_EXIT_EVENT_NAME = "loom://terminal-exit";

export const THEME_STORAGE_KEY = "loom-theme";
export const LEGACY_THEME_STORAGE_KEY = "threadex-theme";
export const TERMINAL_HEIGHT_STORAGE_KEY = "loom-terminal-height";
export const LEGACY_TERMINAL_HEIGHT_STORAGE_KEY = "threadex-terminal-height";
export const TERMINAL_VISIBLE_STORAGE_KEY = "loom-terminal-visible";
export const LEGACY_TERMINAL_VISIBLE_STORAGE_KEY = "threadex-terminal-visible";
export const VOICE_PROCESSOR_NAME = "loom-voice-processor";

export const RELEASES_BASE_URL =
  "https://github.com/paul-bouzian/Loom/releases/tag";

export function readLocalStorageWithMigration(
  key: string,
  legacyKey: string,
): string | null {
  try {
    const currentValue = localStorage.getItem(key);
    if (currentValue != null) {
      return currentValue;
    }

    const legacyValue = localStorage.getItem(legacyKey);
    if (legacyValue == null) {
      return null;
    }

    localStorage.setItem(key, legacyValue);
    localStorage.removeItem(legacyKey);
    return legacyValue;
  } catch {
    return null;
  }
}
