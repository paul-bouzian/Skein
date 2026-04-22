import { create } from "zustand";

import {
  LEGACY_SIDE_PANEL_WIDTH_STORAGE_KEYS,
  SIDE_PANEL_WIDTH_STORAGE_KEY,
} from "../lib/app-identity";
import {
  persistUiPreference,
  readUiPreferenceWithMigration,
} from "../lib/ui-prefs";

export const SIDE_PANEL_MIN_WIDTH = 280;
export const SIDE_PANEL_MAX_WIDTH = 900;
export const SIDE_PANEL_DEFAULT_WIDTH = 420;

const PERSIST_DEBOUNCE_MS = 100;

export function clampSidePanelWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDE_PANEL_DEFAULT_WIDTH;
  return Math.round(
    Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(SIDE_PANEL_MIN_WIDTH, value)),
  );
}

function readPersistedWidth(): number {
  try {
    const raw = readUiPreferenceWithMigration(
      SIDE_PANEL_WIDTH_STORAGE_KEY,
      LEGACY_SIDE_PANEL_WIDTH_STORAGE_KEYS,
    );
    if (raw == null) return SIDE_PANEL_DEFAULT_WIDTH;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return SIDE_PANEL_DEFAULT_WIDTH;
    return clampSidePanelWidth(parsed);
  } catch {
    return SIDE_PANEL_DEFAULT_WIDTH;
  }
}

let persistTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

function persistWidthNow(width: number) {
  void persistUiPreference(SIDE_PANEL_WIDTH_STORAGE_KEY, String(width));
}

function schedulePersistWidth(width: number) {
  if (persistTimer !== null) {
    globalThis.clearTimeout(persistTimer);
  }
  persistTimer = globalThis.setTimeout(() => {
    persistTimer = null;
    persistWidthNow(width);
  }, PERSIST_DEBOUNCE_MS);
}

type SidePanelState = {
  width: number;
  setWidth: (value: number) => void;
};

export const useSidePanelStore = create<SidePanelState>((set, get) => ({
  width: readPersistedWidth(),
  setWidth: (value: number) => {
    const clamped = clampSidePanelWidth(value);
    if (clamped === get().width) return;
    set({ width: clamped });
    schedulePersistWidth(clamped);
  },
}));

export function selectSidePanelWidth(state: SidePanelState): number {
  return state.width;
}
