import { create } from "zustand";

import { RELEASES_BASE_URL } from "../lib/app-identity";
import * as bridge from "../lib/bridge";
import type {
  DesktopUpdate,
  DesktopUpdateDownloadEvent,
} from "../lib/desktop-types";
import { openExternalUrl, updater } from "../lib/shell";
import type { AppUpdateSnapshot, AppUpdateState } from "../lib/types";

const PENDING_RELEASE_NOTES_KEY = "skein-pending-release-notes";

export type PendingReleaseNotes = {
  version: string;
  notes: string | null;
  releaseDate: string | null;
  releaseUrl: string;
};

type UpdateStore = {
  state: AppUpdateState;
  snapshot: AppUpdateSnapshot | null;
  error: string | null;
  downloadedBytes: number;
  contentLength: number | null;
  noticeVisible: boolean;
  hasInitialized: boolean;
  simulating: boolean;
  pendingReleaseNotes: PendingReleaseNotes | null;
  initialize: () => Promise<void>;
  checkNow: (options?: { announceNoUpdate?: boolean }) => Promise<void>;
  dismiss: () => void;
  viewChanges: () => Promise<void>;
  startDownload: () => Promise<void>;
  installAndRestart: () => Promise<void>;
  simulateUpdateFlow: () => void;
  consumePendingReleaseNotes: () => void;
  dismissReleaseNotes: () => void;
};

type UpdateSetter = (
  partial:
    | UpdateStore
    | Partial<UpdateStore>
    | ((state: UpdateStore) => UpdateStore | Partial<UpdateStore>),
) => void;

const SIMULATED_TOTAL_BYTES = 50 * 1024 * 1024;
const SIMULATED_TICK_BYTES = SIMULATED_TOTAL_BYTES / 20;
const SIMULATED_TICK_MS = 250;

let pendingUpdate: DesktopUpdate | null = null;
let initialization: Promise<void> | null = null;
let queuedManualCheck: Promise<void> | null = null;
let simulationInterval: ReturnType<typeof setInterval> | null = null;
let simulationTimeout: ReturnType<typeof setTimeout> | null = null;

export const useAppUpdateStore = create<UpdateStore>((set, get) => ({
  state: "idle",
  snapshot: null,
  error: null,
  downloadedBytes: 0,
  contentLength: null,
  noticeVisible: false,
  hasInitialized: false,
  simulating: false,
  pendingReleaseNotes: null,

  initialize: async () => {
    if (get().hasInitialized) {
      return;
    }

    if (initialization) {
      await initialization;
      return;
    }

    get().consumePendingReleaseNotes();

    const task = get().checkNow({ announceNoUpdate: false });
    initialization = task;
    try {
      await task;
    } finally {
      set({ hasInitialized: true });
      if (initialization === task) {
        initialization = null;
      }
    }
  },

  checkNow: async (options) => {
    const currentState = get().state;
    if (
      currentState === "installing" ||
      currentState === "downloading" ||
      currentState === "downloaded" ||
      get().simulating
    ) {
      return;
    }

    const announceNoUpdate = options?.announceNoUpdate ?? true;
    const silent = !announceNoUpdate;

    if (silent && currentState === "available") {
      return;
    }

    if (get().state === "checking") {
      if (!initialization || !announceNoUpdate) {
        return;
      }
      if (queuedManualCheck) {
        await queuedManualCheck;
        return;
      }

      const followUpCheck = (async () => {
        await initialization;
        if (get().state === "idle" && !get().snapshot) {
          await get().checkNow(options);
        }
      })();

      queuedManualCheck = followUpCheck;
      try {
        await followUpCheck;
      } finally {
        if (queuedManualCheck === followUpCheck) {
          queuedManualCheck = null;
        }
      }
      return;
    }

    set({
      state: "checking",
      snapshot: null,
      error: null,
      noticeVisible: !silent,
      downloadedBytes: 0,
      contentLength: null,
    });

    try {
      const update = await updater.check();
      await replacePendingUpdate(update);
      if (!update) {
        set({
          state: announceNoUpdate ? "latest" : "idle",
          snapshot: null,
          error: null,
          noticeVisible: announceNoUpdate,
          downloadedBytes: 0,
          contentLength: null,
        });
        return;
      }

      set({
        state: "available",
        snapshot: toUpdateSnapshot(update),
        error: null,
        noticeVisible: true,
        downloadedBytes: 0,
        contentLength: null,
      });
    } catch (cause: unknown) {
      await replacePendingUpdate(null);
      const message =
        cause instanceof Error ? cause.message : "Failed to check for updates";
      set({
        state: silent ? "idle" : "error",
        snapshot: null,
        error: silent ? null : message,
        noticeVisible: !silent,
        downloadedBytes: 0,
        contentLength: null,
      });
    }
  },

  dismiss: () => {
    const state = get().state;
    if (
      state === "downloading" ||
      state === "downloaded" ||
      state === "installing"
    ) {
      return;
    }

    if (state === "available") {
      set({
        noticeVisible: false,
        error: null,
      });
      return;
    }

    void replacePendingUpdate(null);
    set({
      state: "idle",
      snapshot: null,
      error: null,
      noticeVisible: false,
      downloadedBytes: 0,
      contentLength: null,
    });
  },

  viewChanges: async () => {
    const snapshot = get().snapshot;
    if (!snapshot) return;
    await openExternalUrl(snapshot.releaseUrl);
  },

  startDownload: async () => {
    if (get().state !== "available") return;

    if (get().simulating) {
      runSimulatedDownload(set, get);
      return;
    }

    const update = pendingUpdate;
    const snapshot = get().snapshot;
    if (!update || !snapshot) {
      await replacePendingUpdate(null);
      set({
        state: "error",
        error: "Update download is no longer available. Check for updates again.",
        noticeVisible: true,
        downloadedBytes: 0,
        contentLength: null,
      });
      return;
    }

    set({
      state: "downloading",
      error: null,
      noticeVisible: true,
      downloadedBytes: 0,
      contentLength: null,
    });

    try {
      await updater.downloadAndInstall(update.id, (event) => {
        applyDownloadEvent(event, set);
      });
      // Persist as soon as the bytes are on disk so the release notes card
      // still surfaces if the user quits before pressing Install — Electron's
      // updater is configured with autoInstallOnAppQuit, which would otherwise
      // apply the update without us having stored the notes.
      const pending = snapshotToPendingNotes(snapshot);
      if (pending) {
        persistPendingReleaseNotes(pending);
      }
      set({ state: "downloaded", error: null });
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to download the update";
      set({
        state: "available",
        error: message,
        downloadedBytes: 0,
        contentLength: null,
      });
    }
  },

  installAndRestart: async () => {
    if (get().state !== "downloaded") return;

    if (get().simulating) {
      console.info("[update] Simulation: install and restart triggered");
      const fakeNotes = snapshotToPendingNotes(get().snapshot);
      set({ state: "installing" });
      simulationTimeout = setTimeout(() => {
        simulationTimeout = null;
        clearSimulation();
        set({
          state: "idle",
          snapshot: null,
          error: null,
          noticeVisible: false,
          downloadedBytes: 0,
          contentLength: null,
          simulating: false,
          pendingReleaseNotes: fakeNotes,
        });
      }, 1500);
      return;
    }

    set({ state: "installing", error: null });

    try {
      await replacePendingUpdate(null);
      await bridge.restartApp();
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to install the update";
      set({ state: "downloaded", error: message });
    }
  },

  simulateUpdateFlow: () => {
    clearSimulation();
    set({
      simulating: true,
      state: "available",
      snapshot: {
        currentVersion: "0.0.0",
        availableVersion: "9.9.9-dev",
        releaseDate: new Date().toISOString(),
        notes: SIMULATED_RELEASE_NOTES,
        releaseUrl: `${RELEASES_BASE_URL}/v9.9.9-dev`,
      },
      error: null,
      noticeVisible: true,
      downloadedBytes: 0,
      contentLength: null,
      pendingReleaseNotes: null,
    });
  },

  consumePendingReleaseNotes: () => {
    const stored = readPersistedReleaseNotes();
    if (!stored) return;
    clearPersistedReleaseNotes();
    set({ pendingReleaseNotes: stored });
  },

  dismissReleaseNotes: () => {
    set({ pendingReleaseNotes: null });
  },
}));

const SIMULATED_RELEASE_NOTES = `## What's Changed

- studio: glass-morphism sidebar with native macOS vibrancy by @paul-bouzian in #97
- studio: new compact update pill in the sidebar header by @paul-bouzian in #98
- fix: stream Claude work activity in real time by @paul-bouzian in #96
- feat: refresh sidebar, work activity, composer & selectors UX by @paul-bouzian in #95
- feat: replace browser iframe with native WebContentsView by @paul-bouzian in #93
- fix: restore proper font rendering under Electron by @paul-bouzian in #92

**Full Changelog**: https://github.com/paul-bouzian/Skein/compare/v0.1.24...v9.9.9-dev`;

function snapshotToPendingNotes(
  snapshot: AppUpdateSnapshot | null,
): PendingReleaseNotes | null {
  if (!snapshot) return null;
  return {
    version: snapshot.availableVersion,
    notes: snapshot.notes ?? null,
    releaseDate: snapshot.releaseDate ?? null,
    releaseUrl: snapshot.releaseUrl,
  };
}

function persistPendingReleaseNotes(value: PendingReleaseNotes) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PENDING_RELEASE_NOTES_KEY, JSON.stringify(value));
  } catch {
    // Storage quota or privacy mode — fail silently, the card just won't show.
  }
}

function readPersistedReleaseNotes(): PendingReleaseNotes | null {
  if (typeof localStorage === "undefined") return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(PENDING_RELEASE_NOTES_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingReleaseNotes>;
    if (typeof parsed?.version === "string") {
      return {
        version: parsed.version,
        notes: typeof parsed.notes === "string" ? parsed.notes : null,
        releaseDate:
          typeof parsed.releaseDate === "string" ? parsed.releaseDate : null,
        releaseUrl: buildReleaseUrl(parsed.version),
      };
    }
  } catch {
    // Corrupted entry — clear it below.
  }
  clearPersistedReleaseNotes();
  return null;
}

function clearPersistedReleaseNotes() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(PENDING_RELEASE_NOTES_KEY);
  } catch {
    // Ignore.
  }
}

function applyDownloadEvent(event: DesktopUpdateDownloadEvent, set: UpdateSetter) {
  switch (event.event) {
    case "Started":
      set({
        contentLength: event.data.contentLength ?? null,
        downloadedBytes: 0,
      });
      break;
    case "Progress":
      set((state) => ({
        downloadedBytes: state.downloadedBytes + event.data.chunkLength,
      }));
      break;
    case "Finished":
      set((state) => ({
        downloadedBytes: state.contentLength ?? state.downloadedBytes,
      }));
      break;
  }
}

function runSimulatedDownload(
  set: UpdateSetter,
  get: () => UpdateStore,
) {
  clearSimulation();
  set({
    state: "downloading",
    error: null,
    downloadedBytes: 0,
    contentLength: SIMULATED_TOTAL_BYTES,
  });

  simulationInterval = setInterval(() => {
    if (!get().simulating) {
      clearSimulation();
      return;
    }
    const next = get().downloadedBytes + SIMULATED_TICK_BYTES;
    if (next >= SIMULATED_TOTAL_BYTES) {
      clearSimulation();
      set({
        state: "downloaded",
        downloadedBytes: SIMULATED_TOTAL_BYTES,
      });
      return;
    }
    set({ downloadedBytes: next });
  }, SIMULATED_TICK_MS);
}

function clearSimulation() {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
  if (simulationTimeout) {
    clearTimeout(simulationTimeout);
    simulationTimeout = null;
  }
}

async function replacePendingUpdate(next: DesktopUpdate | null) {
  const previous = pendingUpdate;
  pendingUpdate = next;

  if (previous && previous !== next) {
    await updater.close(previous.id).catch(() => undefined);
  }
}

function toUpdateSnapshot(update: DesktopUpdate): AppUpdateSnapshot {
  return {
    currentVersion: update.currentVersion,
    availableVersion: update.version,
    releaseDate: update.date ?? null,
    notes: update.body ?? null,
    releaseUrl: buildReleaseUrl(update.version),
  };
}

function buildReleaseUrl(version: string) {
  const normalizedVersion = version.startsWith("v") ? version : `v${version}`;
  return `${RELEASES_BASE_URL}/${normalizedVersion}`;
}
