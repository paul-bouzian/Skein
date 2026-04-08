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
  initialize: () => Promise<void>;
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

export const useAppUpdateStore = create<UpdateStore>((set, get) => ({
  state: "idle",
  snapshot: null,
  error: null,
  downloadedBytes: 0,
  contentLength: null,

  initialize: async () => {
    if (get().state !== "idle") return;
    if (initialization) {
      await initialization;
      return;
    }

    const task = (async () => {
      set({ state: "checking", error: null });
      try {
        const update = await check();
        await replacePendingUpdate(update);
        if (!update) {
          set({
            state: "idle",
            snapshot: null,
            error: null,
            downloadedBytes: 0,
            contentLength: null,
          });
          return;
        }

        set({
          state: "available",
          snapshot: toUpdateSnapshot(update),
          error: null,
          downloadedBytes: 0,
          contentLength: null,
        });
      } catch {
        await replacePendingUpdate(null);
        set({
          state: "idle",
          snapshot: null,
          error: null,
          downloadedBytes: 0,
          contentLength: null,
        });
      }
    })();

    initialization = task;
    try {
      await task;
    } finally {
      if (initialization === task) {
        initialization = null;
      }
    }
  },

  dismiss: () => {
    void replacePendingUpdate(null);
    set({
      state: "dismissed",
      snapshot: null,
      error: null,
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
