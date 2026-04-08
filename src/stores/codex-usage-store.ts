import { create } from "zustand";

import * as bridge from "../lib/bridge";
import type { CodexRateLimitSnapshot } from "../lib/types";

const USAGE_CACHE_TTL_MS = 60_000;

type RefreshAccountUsageOptions = {
  silent?: boolean;
};

type CodexUsageState = {
  snapshot: CodexRateLimitSnapshot | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  listenerReady: boolean;

  initializeListener: () => Promise<void>;
  ensureAccountUsage: (environmentId: string | null) => Promise<void>;
  refreshAccountUsage: (
    environmentId: string,
    options?: RefreshAccountUsageOptions,
  ) => Promise<void>;
};

type CodexUsageSet = (
  updater: (state: CodexUsageState) => Partial<CodexUsageState>,
) => void;

let unlistenCodexUsageEvents: null | (() => void) = null;
let listenerInitialization: Promise<void> | null = null;
let listenerGeneration = 0;
let inflightUsageFetch: Promise<void> | null = null;

export const useCodexUsageStore = create<CodexUsageState>((set, get) => ({
  snapshot: null,
  loading: false,
  error: null,
  lastFetchedAt: null,
  listenerReady: false,

  initializeListener: async () => {
    if (get().listenerReady) return;
    if (listenerInitialization) {
      await listenerInitialization;
      return;
    }

    const generation = listenerGeneration;
    const initialization = bridge
      .listenToCodexUsageEvents((payload) => {
        setUsageSnapshot(set, payload.rateLimits);
      })
      .then((unlisten) => {
        if (generation !== listenerGeneration) {
          unlisten();
          return;
        }
        unlistenCodexUsageEvents = unlisten;
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

  ensureAccountUsage: async (environmentId) => {
    if (!environmentId) return;

    if (inflightUsageFetch) {
      await inflightUsageFetch;
    }

    const state = get();
    const lastFetchedAt = state.lastFetchedAt;
    if (isUsageSnapshotFresh(lastFetchedAt)) {
      return;
    }

    await state.refreshAccountUsage(environmentId, {
      silent: state.snapshot !== null,
    });
  },

  refreshAccountUsage: async (environmentId, options = {}) => {
    while (inflightUsageFetch) {
      await inflightUsageFetch;
      if (isUsageSnapshotFresh(get().lastFetchedAt)) {
        return;
      }
    }

    const requestStartedAt = Date.now();
    const request = (async () => {
      setUsageLoading(set);

      try {
        const snapshot = await bridge.getEnvironmentCodexRateLimits(environmentId);
        if (isUsageFetchStale(get, requestStartedAt)) {
          return;
        }
        setUsageSnapshot(set, snapshot);
      } catch (cause: unknown) {
        if (isUsageFetchStale(get, requestStartedAt)) {
          return;
        }
        const message =
          cause instanceof Error ? cause.message : "Failed to load Codex usage";
        setUsageError(set, message, options.silent ?? false);
      }
    })();

    inflightUsageFetch = request;
    try {
      await request;
    } finally {
      if (inflightUsageFetch === request) {
        inflightUsageFetch = null;
      }
    }
  },
}));

export function teardownCodexUsageListener() {
  listenerGeneration += 1;
  unlistenCodexUsageEvents?.();
  unlistenCodexUsageEvents = null;
  listenerInitialization = null;
  inflightUsageFetch = null;
  useCodexUsageStore.setState({ listenerReady: false });
}

function setUsageLoading(set: CodexUsageSet) {
  set((state) => ({
    loading: true,
    error: state.snapshot === null ? null : state.error,
  }));
}

function setUsageSnapshot(
  set: CodexUsageSet,
  snapshot: CodexRateLimitSnapshot,
) {
  const fetchedAt = Date.now();
  set((state) => ({
    snapshot: mergeUsageSnapshot(state.snapshot, snapshot),
    loading: false,
    error: null,
    lastFetchedAt: fetchedAt,
  }));
}

function mergeUsageSnapshot(
  previous: CodexRateLimitSnapshot | null,
  next: CodexRateLimitSnapshot,
): CodexRateLimitSnapshot {
  return {
    credits: mergeUsageValue(previous?.credits, next.credits),
    limitId: mergeUsageValue(previous?.limitId, next.limitId),
    limitName: mergeUsageValue(previous?.limitName, next.limitName),
    planType: mergeUsageValue(previous?.planType, next.planType),
    primary: mergeUsageWindow(previous?.primary, next.primary),
    secondary: mergeUsageWindow(previous?.secondary, next.secondary),
  };
}

function mergeUsageValue<T>(
  previous: T | null | undefined,
  next: T | null | undefined,
) {
  return next === undefined ? previous : next;
}

function mergeUsageWindow(
  previous: CodexRateLimitSnapshot["primary"] | undefined,
  next: CodexRateLimitSnapshot["primary"] | undefined,
) {
  if (next === undefined) {
    return previous;
  }
  if (next === null) {
    return null;
  }

  return {
    ...previous,
    ...next,
  };
}

function isUsageFetchStale(
  get: () => CodexUsageState,
  requestStartedAt: number,
) {
  const latestAppliedAt = get().lastFetchedAt ?? Number.NEGATIVE_INFINITY;
  return latestAppliedAt > requestStartedAt;
}

function isUsageSnapshotFresh(lastFetchedAt: number | null) {
  return lastFetchedAt !== null && Date.now() - lastFetchedAt < USAGE_CACHE_TTL_MS;
}

function setUsageError(
  set: CodexUsageSet,
  message: string,
  silent: boolean,
) {
  set((state) => ({
    loading: false,
    error: silent && state.snapshot !== null ? null : message,
    lastFetchedAt: silent && state.snapshot !== null ? state.lastFetchedAt : null,
  }));
}
