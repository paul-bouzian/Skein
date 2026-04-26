import { create } from "zustand";

import {
  LEGACY_SIDEBAR_CHATS_SORT_STORAGE_KEYS,
  LEGACY_SIDEBAR_PROJECTS_SORT_STORAGE_KEYS,
  SIDEBAR_CHATS_SORT_STORAGE_KEY,
  SIDEBAR_PROJECTS_SORT_STORAGE_KEY,
} from "../lib/app-identity";
import {
  persistUiPreference,
  readUiPreferenceWithMigration,
} from "../lib/ui-prefs";
import type { ThreadRecord } from "../lib/types";

export type ThreadSortMode = "lastMessage" | "createdFirst" | "alphabetical";

const VALID_MODES: readonly ThreadSortMode[] = [
  "lastMessage",
  "createdFirst",
  "alphabetical",
];

const DEFAULT_MODE: ThreadSortMode = "lastMessage";

function parseMode(raw: string | null): ThreadSortMode {
  if (raw && (VALID_MODES as readonly string[]).includes(raw)) {
    return raw as ThreadSortMode;
  }
  return DEFAULT_MODE;
}

function readPersistedMode(
  key: string,
  legacyKeys: readonly string[],
): ThreadSortMode {
  try {
    return parseMode(readUiPreferenceWithMigration(key, legacyKeys));
  } catch {
    return DEFAULT_MODE;
  }
}

type SidebarPrefsState = {
  projectsSort: ThreadSortMode;
  chatsSort: ThreadSortMode;
  setProjectsSort: (mode: ThreadSortMode) => void;
  setChatsSort: (mode: ThreadSortMode) => void;
};

export const useSidebarPrefsStore = create<SidebarPrefsState>((set, get) => ({
  projectsSort: readPersistedMode(
    SIDEBAR_PROJECTS_SORT_STORAGE_KEY,
    LEGACY_SIDEBAR_PROJECTS_SORT_STORAGE_KEYS,
  ),
  chatsSort: readPersistedMode(
    SIDEBAR_CHATS_SORT_STORAGE_KEY,
    LEGACY_SIDEBAR_CHATS_SORT_STORAGE_KEYS,
  ),
  setProjectsSort: (mode) => {
    if (get().projectsSort === mode) return;
    set({ projectsSort: mode });
    void persistUiPreference(SIDEBAR_PROJECTS_SORT_STORAGE_KEY, mode);
  },
  setChatsSort: (mode) => {
    if (get().chatsSort === mode) return;
    set({ chatsSort: mode });
    void persistUiPreference(SIDEBAR_CHATS_SORT_STORAGE_KEY, mode);
  },
}));

export function selectProjectsSort(state: SidebarPrefsState): ThreadSortMode {
  return state.projectsSort;
}

export function selectChatsSort(state: SidebarPrefsState): ThreadSortMode {
  return state.chatsSort;
}

function timestampValue(value: string | undefined | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareThreadsByMode(
  mode: ThreadSortMode,
): (left: ThreadRecord, right: ThreadRecord) => number {
  if (mode === "createdFirst") {
    // Oldest-created first — matches the literal reading of the "Created first"
    // label and gives a useful chronological view distinct from "Last message".
    return (left, right) =>
      timestampValue(left.createdAt) - timestampValue(right.createdAt);
  }
  if (mode === "alphabetical") {
    return (left, right) =>
      (left.title ?? "").localeCompare(right.title ?? "", undefined, {
        sensitivity: "base",
      });
  }
  return (left, right) =>
    timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
}

export const SORT_MODE_LABELS: Record<ThreadSortMode, string> = {
  lastMessage: "Last message",
  createdFirst: "Created first",
  alphabetical: "Alphabetical",
};

export const SORT_MODES: readonly ThreadSortMode[] = VALID_MODES;
