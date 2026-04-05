import { create } from "zustand";

import * as bridge from "../lib/bridge";
import type { WorktreeScriptFailureEventPayload } from "../lib/types";

type WorktreeScriptState = {
  latestFailure: WorktreeScriptFailureEventPayload | null;
  listenerReady: boolean;
  initializeListener: () => Promise<void>;
  dismissLatestFailure: () => void;
};

let unlistenWorktreeScriptFailures: null | (() => void) = null;
let listenerInitialization: Promise<void> | null = null;
let listenerGeneration = 0;

export const useWorktreeScriptStore = create<WorktreeScriptState>((set, get) => ({
  latestFailure: null,
  listenerReady: false,

  initializeListener: async () => {
    if (get().listenerReady) return;
    if (listenerInitialization) {
      await listenerInitialization;
      return;
    }

    const generation = listenerGeneration;
    const initialization = bridge
      .listenToWorktreeScriptFailures((payload) => {
        set({ latestFailure: payload });
      })
      .then((unlisten) => {
        if (generation !== listenerGeneration) {
          unlisten();
          return;
        }

        unlistenWorktreeScriptFailures = unlisten;
        set({ listenerReady: true });
      });
    listenerInitialization = initialization;

    try {
      await initialization;
    } finally {
      if (listenerInitialization === initialization) {
        listenerInitialization = null;
      }
    }
  },

  dismissLatestFailure: () => set({ latestFailure: null }),
}));

export function teardownWorktreeScriptListener() {
  listenerGeneration += 1;
  unlistenWorktreeScriptFailures?.();
  unlistenWorktreeScriptFailures = null;
  listenerInitialization = null;
  useWorktreeScriptStore.setState({ listenerReady: false, latestFailure: null });
}
