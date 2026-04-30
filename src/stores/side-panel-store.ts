import { create } from "zustand";

import {
  LEGACY_SIDE_PANEL_WIDTH_STORAGE_KEYS,
  LEGACY_SIDEBAR_WIDTH_STORAGE_KEYS,
  SIDE_PANEL_WIDTH_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from "../lib/app-identity";
import {
  persistUiPreference,
  readUiPreferenceWithMigration,
} from "../lib/ui-prefs";

export const SIDE_PANEL_MIN_WIDTH = 280;
export const SIDE_PANEL_MAX_WIDTH = 900;
export const SIDE_PANEL_DEFAULT_WIDTH = 420;
export const SIDEBAR_PANEL_MIN_WIDTH = 240;
export const SIDEBAR_PANEL_MAX_WIDTH = 420;
export const SIDEBAR_PANEL_DEFAULT_WIDTH = 256;

const PERSIST_DEBOUNCE_MS = 100;
type WidthClamp = (value: number) => number;

export function clampSidePanelWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDE_PANEL_DEFAULT_WIDTH;
  return Math.round(
    Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(SIDE_PANEL_MIN_WIDTH, value)),
  );
}

export function clampSidebarPanelWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_PANEL_DEFAULT_WIDTH;
  return Math.round(
    Math.min(SIDEBAR_PANEL_MAX_WIDTH, Math.max(SIDEBAR_PANEL_MIN_WIDTH, value)),
  );
}

function readPersistedWidth(
  storageKey: string,
  legacyStorageKeys: readonly string[],
  defaultWidth: number,
  clampWidth: WidthClamp,
): number {
  try {
    const raw = readUiPreferenceWithMigration(storageKey, legacyStorageKeys);
    if (raw == null) return defaultWidth;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return defaultWidth;
    return clampWidth(parsed);
  } catch {
    return defaultWidth;
  }
}

let persistTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let sidebarPersistTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

function schedulePersistedWidth(
  storageKey: string,
  width: number,
  currentTimer: ReturnType<typeof globalThis.setTimeout> | null,
  onPersisted: () => void,
): ReturnType<typeof globalThis.setTimeout> {
  if (currentTimer !== null) {
    globalThis.clearTimeout(currentTimer);
  }
  return globalThis.setTimeout(() => {
    onPersisted();
    void persistUiPreference(storageKey, String(width));
  }, PERSIST_DEBOUNCE_MS);
}

type SidePanelState = {
  width: number;
  sidebarWidth: number;
  setWidth: (value: number) => void;
  setSidebarWidth: (value: number) => void;
};

export const useSidePanelStore = create<SidePanelState>((set, get) => ({
  width: readPersistedWidth(
    SIDE_PANEL_WIDTH_STORAGE_KEY,
    LEGACY_SIDE_PANEL_WIDTH_STORAGE_KEYS,
    SIDE_PANEL_DEFAULT_WIDTH,
    clampSidePanelWidth,
  ),
  sidebarWidth: readPersistedWidth(
    SIDEBAR_WIDTH_STORAGE_KEY,
    LEGACY_SIDEBAR_WIDTH_STORAGE_KEYS,
    SIDEBAR_PANEL_DEFAULT_WIDTH,
    clampSidebarPanelWidth,
  ),
  setWidth: (value: number) => {
    const clamped = clampSidePanelWidth(value);
    if (clamped === get().width) return;
    set({ width: clamped });
    persistTimer = schedulePersistedWidth(
      SIDE_PANEL_WIDTH_STORAGE_KEY,
      clamped,
      persistTimer,
      () => {
        persistTimer = null;
      },
    );
  },
  setSidebarWidth: (value: number) => {
    const clamped = clampSidebarPanelWidth(value);
    if (clamped === get().sidebarWidth) return;
    set({ sidebarWidth: clamped });
    sidebarPersistTimer = schedulePersistedWidth(
      SIDEBAR_WIDTH_STORAGE_KEY,
      clamped,
      sidebarPersistTimer,
      () => {
        sidebarPersistTimer = null;
      },
    );
  },
}));

export function selectSidePanelWidth(state: SidePanelState): number {
  return state.width;
}

export function selectSidebarPanelWidth(state: SidePanelState): number {
  return state.sidebarWidth;
}
