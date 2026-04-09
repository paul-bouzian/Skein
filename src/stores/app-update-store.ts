import { create } from "zustand";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";

import { RELEASES_BASE_URL } from "../lib/app-identity";
import * as bridge from "../lib/bridge";
import type { AppUpdateSnapshot, AppUpdateState } from "../lib/types";

type UpdateStore = {
  state: AppUpdateState;
  snapshot: AppUpdateSnapshot | null;
  error: string | null;
  downloadedBytes: number;
  contentLength: number | null;
  noticeVisible: boolean;
  hasInitialized: boolean;
  initialize: () => Promise<void>;
  checkNow: (options?: { announceNoUpdate?: boolean }) => Promise<void>;
  dismiss: () => void;
  viewChanges: () => Promise<void>;
  install: () => Promise<void>;
};

type UpdateSetter = (
  partial:
    | UpdateStore
    | Partial<UpdateStore>
    | ((state: UpdateStore) => UpdateStore | Partial<UpdateStore>),
) => void;

let pendingUpdate: Update | null = null;
let initialization: Promise<void> | null = null;
let queuedManualCheck: Promise<void> | null = null;

export const useAppUpdateStore = create<UpdateStore>((set, get) => ({
  state: "idle",
  snapshot: null,
  error: null,
  downloadedBytes: 0,
  contentLength: null,
  noticeVisible: false,
  hasInitialized: false,

  initialize: async () => {
    if (get().hasInitialized) {
      return;
    }

    if (initialization) {
      await initialization;
      return;
    }

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
    if (get().state === "installing") {
      return;
    }

    const announceNoUpdate = options?.announceNoUpdate ?? true;
    const silent = !announceNoUpdate;

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
      const update = await check();
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
    if (state === "installing") {
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
    await openUrl(snapshot.releaseUrl);
  },

  install: async () => {
    if (!pendingUpdate || !get().snapshot) return;

    set({
      state: "installing",
      error: null,
      noticeVisible: true,
      downloadedBytes: 0,
      contentLength: null,
    });

    try {
      await pendingUpdate.downloadAndInstall((event) => {
        applyDownloadEvent(event, set);
      });
      await replacePendingUpdate(null);
      await bridge.restartApp();
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to install the update";
      set({
        state: "available",
        error: message,
        noticeVisible: true,
      });
    }
  },
}));

function applyDownloadEvent(event: DownloadEvent, set: UpdateSetter) {
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

async function replacePendingUpdate(next: Update | null) {
  const previous = pendingUpdate;
  pendingUpdate = next;

  if (previous && previous !== next) {
    await previous.close().catch(() => undefined);
  }
}

function toUpdateSnapshot(update: Update): AppUpdateSnapshot {
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
