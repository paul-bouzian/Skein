import { create } from "zustand";

import * as bridge from "../lib/bridge";
import type { CodexRateLimitSnapshot } from "../lib/types";

const USAGE_CACHE_TTL_MS = 60_000;

type CodexUsageState = {
  snapshotsByEnvironmentId: Record<string, CodexRateLimitSnapshot | null>;
  loadingByEnvironmentId: Record<string, boolean>;
  errorByEnvironmentId: Record<string, string | null>;
  lastFetchedAtByEnvironmentId: Record<string, number | null>;
  listenerReady: boolean;

  initializeListener: () => Promise<void>;
  ensureEnvironmentUsage: (environmentId: string | null) => Promise<void>;
  refreshEnvironmentUsage: (environmentId: string) => Promise<void>;
};

type CodexUsageSet = (
  updater: (state: CodexUsageState) => Partial<CodexUsageState>,
) => void;

let unlistenCodexUsageEvents: null | (() => void) = null;
let listenerInitialization: Promise<void> | null = null;
let listenerGeneration = 0;

export const useCodexUsageStore = create<CodexUsageState>((set, get) => ({
  snapshotsByEnvironmentId: {},
  loadingByEnvironmentId: {},
  errorByEnvironmentId: {},
  lastFetchedAtByEnvironmentId: {},
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
        setUsageSnapshot(set, payload.environmentId, payload.rateLimits);
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

  ensureEnvironmentUsage: async (environmentId) => {
    if (!environmentId) return;

    const state = get();
    if (state.loadingByEnvironmentId[environmentId]) {
      return;
    }

    const lastFetchedAt = state.lastFetchedAtByEnvironmentId[environmentId] ?? null;
    if (lastFetchedAt !== null && Date.now() - lastFetchedAt < USAGE_CACHE_TTL_MS) {
      return;
    }

    await state.refreshEnvironmentUsage(environmentId);
  },

  refreshEnvironmentUsage: async (environmentId) => {
    const requestStartedAt = Date.now();
    setUsageLoading(set, environmentId);

    try {
      const snapshot = await bridge.getEnvironmentCodexRateLimits(environmentId);
      if (isUsageFetchStale(get, environmentId, requestStartedAt)) {
        return;
      }
      setUsageSnapshot(set, environmentId, snapshot);
    } catch (cause: unknown) {
      if (isUsageFetchStale(get, environmentId, requestStartedAt)) {
        return;
      }
      const message =
        cause instanceof Error ? cause.message : "Failed to load Codex usage";
      setUsageError(set, environmentId, message);
    }
  },
}));

export function teardownCodexUsageListener() {
  listenerGeneration += 1;
  unlistenCodexUsageEvents?.();
  unlistenCodexUsageEvents = null;
  listenerInitialization = null;
  useCodexUsageStore.setState({ listenerReady: false });
}

function setUsageLoading(
  set: CodexUsageSet,
  environmentId: string,
) {
  set((state) => ({
    loadingByEnvironmentId: {
      ...state.loadingByEnvironmentId,
      [environmentId]: true,
    },
    errorByEnvironmentId: {
      ...state.errorByEnvironmentId,
      [environmentId]: null,
    },
  }));
}

function setUsageSnapshot(
  set: CodexUsageSet,
  environmentId: string,
  snapshot: CodexRateLimitSnapshot,
) {
  const fetchedAt = Date.now();
  set((state) => ({
    snapshotsByEnvironmentId: {
      ...state.snapshotsByEnvironmentId,
      [environmentId]: mergeUsageSnapshot(
        state.snapshotsByEnvironmentId[environmentId] ?? null,
        snapshot,
      ),
    },
    loadingByEnvironmentId: {
      ...state.loadingByEnvironmentId,
      [environmentId]: false,
    },
    errorByEnvironmentId: {
      ...state.errorByEnvironmentId,
      [environmentId]: null,
    },
    lastFetchedAtByEnvironmentId: {
      ...state.lastFetchedAtByEnvironmentId,
      [environmentId]: fetchedAt,
    },
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
  environmentId: string,
  requestStartedAt: number,
) {
  const latestAppliedAt =
    get().lastFetchedAtByEnvironmentId[environmentId] ?? Number.NEGATIVE_INFINITY;
  return latestAppliedAt > requestStartedAt;
}

function setUsageError(
  set: CodexUsageSet,
  environmentId: string,
  message: string,
) {
  set((state) => ({
    loadingByEnvironmentId: {
      ...state.loadingByEnvironmentId,
      [environmentId]: false,
    },
    errorByEnvironmentId: {
      ...state.errorByEnvironmentId,
      [environmentId]: message,
    },
    lastFetchedAtByEnvironmentId: {
      ...state.lastFetchedAtByEnvironmentId,
      [environmentId]: null,
    },
  }));
}
