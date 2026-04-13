export const APP_NAME = "Skein";
export const APP_SLUG = "skein";
export const PREVIOUS_APP_NAME = "Loom";
export const PREVIOUS_APP_SLUG = "loom";
export const LEGACY_APP_NAME = "ThreadEx";
export const LEGACY_APP_SLUG = "threadex";

const LEGACY_APP_SLUGS = [PREVIOUS_APP_SLUG, LEGACY_APP_SLUG] as const;

function buildEventName(slug: string, event: string) {
  return `${slug}://${event}`;
}

function buildLegacyEventNames(event: string) {
  return LEGACY_APP_SLUGS.map((slug) => buildEventName(slug, event));
}

function buildStorageKey(slug: string, key: string) {
  return `${slug}-${key}`;
}

function buildLegacyStorageKeys(key: string) {
  return LEGACY_APP_SLUGS.map((slug) => buildStorageKey(slug, key));
}

export const CONVERSATION_EVENT_NAME = buildEventName(
  APP_SLUG,
  "conversation-event",
);
export const LEGACY_CONVERSATION_EVENT_NAMES =
  buildLegacyEventNames("conversation-event");
export const CONVERSATION_EVENT_NAMES = [
  CONVERSATION_EVENT_NAME,
  ...LEGACY_CONVERSATION_EVENT_NAMES,
] as const;

export const CODEX_USAGE_EVENT_NAME = buildEventName(
  APP_SLUG,
  "codex-usage-event",
);
export const LEGACY_CODEX_USAGE_EVENT_NAMES =
  buildLegacyEventNames("codex-usage-event");
export const CODEX_USAGE_EVENT_NAMES = [
  CODEX_USAGE_EVENT_NAME,
  ...LEGACY_CODEX_USAGE_EVENT_NAMES,
] as const;

export const WORKTREE_SCRIPT_FAILURE_EVENT_NAME = buildEventName(
  APP_SLUG,
  "worktree-script-failure",
);
export const LEGACY_WORKTREE_SCRIPT_FAILURE_EVENT_NAMES =
  buildLegacyEventNames("worktree-script-failure");
export const WORKTREE_SCRIPT_FAILURE_EVENT_NAMES = [
  WORKTREE_SCRIPT_FAILURE_EVENT_NAME,
  ...LEGACY_WORKTREE_SCRIPT_FAILURE_EVENT_NAMES,
] as const;

export const FIRST_PROMPT_RENAME_FAILURE_EVENT_NAME = buildEventName(
  APP_SLUG,
  "first-prompt-rename-failure",
);
export const LEGACY_FIRST_PROMPT_RENAME_FAILURE_EVENT_NAMES =
  buildLegacyEventNames("first-prompt-rename-failure");
export const FIRST_PROMPT_RENAME_FAILURE_EVENT_NAMES = [
  FIRST_PROMPT_RENAME_FAILURE_EVENT_NAME,
  ...LEGACY_FIRST_PROMPT_RENAME_FAILURE_EVENT_NAMES,
] as const;

export const WORKSPACE_EVENT_NAME = buildEventName(APP_SLUG, "workspace-event");
export const LEGACY_WORKSPACE_EVENT_NAMES =
  buildLegacyEventNames("workspace-event");
export const WORKSPACE_EVENT_NAMES = [
  WORKSPACE_EVENT_NAME,
  ...LEGACY_WORKSPACE_EVENT_NAMES,
] as const;

export const TERMINAL_OUTPUT_EVENT_NAME = buildEventName(
  APP_SLUG,
  "terminal-output",
);
export const LEGACY_TERMINAL_OUTPUT_EVENT_NAMES =
  buildLegacyEventNames("terminal-output");
export const TERMINAL_OUTPUT_EVENT_NAMES = [
  TERMINAL_OUTPUT_EVENT_NAME,
  ...LEGACY_TERMINAL_OUTPUT_EVENT_NAMES,
] as const;

export const TERMINAL_EXIT_EVENT_NAME = buildEventName(APP_SLUG, "terminal-exit");
export const LEGACY_TERMINAL_EXIT_EVENT_NAMES =
  buildLegacyEventNames("terminal-exit");
export const TERMINAL_EXIT_EVENT_NAMES = [
  TERMINAL_EXIT_EVENT_NAME,
  ...LEGACY_TERMINAL_EXIT_EVENT_NAMES,
] as const;

export const MENU_OPEN_SETTINGS_EVENT_NAME = buildEventName(
  APP_SLUG,
  "menu-open-settings",
);
export const LEGACY_MENU_OPEN_SETTINGS_EVENT_NAMES =
  buildLegacyEventNames("menu-open-settings");
export const MENU_OPEN_SETTINGS_EVENT_NAMES = [
  MENU_OPEN_SETTINGS_EVENT_NAME,
  ...LEGACY_MENU_OPEN_SETTINGS_EVENT_NAMES,
] as const;

export const MENU_CHECK_FOR_UPDATES_EVENT_NAME = buildEventName(
  APP_SLUG,
  "menu-check-for-updates",
);
export const LEGACY_MENU_CHECK_FOR_UPDATES_EVENT_NAMES =
  buildLegacyEventNames("menu-check-for-updates");
export const MENU_CHECK_FOR_UPDATES_EVENT_NAMES = [
  MENU_CHECK_FOR_UPDATES_EVENT_NAME,
  ...LEGACY_MENU_CHECK_FOR_UPDATES_EVENT_NAMES,
] as const;

export const THEME_STORAGE_KEY = buildStorageKey(APP_SLUG, "theme");
export const LEGACY_THEME_STORAGE_KEYS = buildLegacyStorageKeys("theme");
export const TERMINAL_HEIGHT_STORAGE_KEY = buildStorageKey(
  APP_SLUG,
  "terminal-height",
);
export const LEGACY_TERMINAL_HEIGHT_STORAGE_KEYS =
  buildLegacyStorageKeys("terminal-height");
export const TERMINAL_VISIBLE_STORAGE_KEY = buildStorageKey(
  APP_SLUG,
  "terminal-visible",
);
export const LEGACY_TERMINAL_VISIBLE_STORAGE_KEYS =
  buildLegacyStorageKeys("terminal-visible");
export const VOICE_PROCESSOR_NAME = buildStorageKey(APP_SLUG, "voice-processor");

export const RELEASES_BASE_URL =
  "https://github.com/paul-bouzian/Skein/releases/tag";

export function readLocalStorageWithMigration(
  key: string,
  legacyKeys: string | readonly string[],
): string | null {
  const keys = Array.isArray(legacyKeys) ? [...legacyKeys] : [legacyKeys];

  try {
    const currentValue = localStorage.getItem(key);
    if (currentValue != null) {
      for (const staleKey of keys) {
        localStorage.removeItem(staleKey);
      }
      return currentValue;
    }

    for (const legacyKey of keys) {
      const legacyValue = localStorage.getItem(legacyKey);
      if (legacyValue == null) {
        continue;
      }

      localStorage.setItem(key, legacyValue);
      for (const staleKey of keys) {
        localStorage.removeItem(staleKey);
      }
      return legacyValue;
    }
  } catch {
    return null;
  }

  return null;
}
