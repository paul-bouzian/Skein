import { create } from "zustand";

import * as bridge from "../lib/bridge";
import type { EnvironmentVoiceStatusSnapshot } from "../lib/types";

const VOICE_STATUS_CACHE_TTL_MS = 60_000;

type VoiceStatusState = {
  snapshotsByEnvironmentId: Record<
    string,
    EnvironmentVoiceStatusSnapshot | null
  >;
  loadingByEnvironmentId: Record<string, boolean>;
  errorByEnvironmentId: Record<string, string | null>;
  lastFetchedAtByEnvironmentId: Record<string, number | null>;
  lastRequestedAtByEnvironmentId: Record<string, number | null>;

  ensureEnvironmentVoiceStatus: (environmentId: string | null) => Promise<void>;
  refreshEnvironmentVoiceStatus: (environmentId: string) => Promise<void>;
};

type VoiceStatusSet = (
  updater: (state: VoiceStatusState) => Partial<VoiceStatusState>,
) => void;

export const useVoiceStatusStore = create<VoiceStatusState>((set, get) => ({
  snapshotsByEnvironmentId: {},
  loadingByEnvironmentId: {},
  errorByEnvironmentId: {},
  lastFetchedAtByEnvironmentId: {},
  lastRequestedAtByEnvironmentId: {},

  ensureEnvironmentVoiceStatus: async (environmentId) => {
    if (!environmentId) {
      return;
    }

    const state = get();
    if (state.loadingByEnvironmentId[environmentId]) {
      return;
    }

    const lastFetchedAt =
      state.lastFetchedAtByEnvironmentId[environmentId] ?? null;
    if (
      lastFetchedAt !== null &&
      Date.now() - lastFetchedAt < VOICE_STATUS_CACHE_TTL_MS
    ) {
      return;
    }

    await state.refreshEnvironmentVoiceStatus(environmentId);
  },

  refreshEnvironmentVoiceStatus: async (environmentId) => {
    const state = get();
    if (state.loadingByEnvironmentId[environmentId]) {
      return;
    }

    const requestStartedAt = nextVoiceStatusRequestStartedAt(
      state,
      environmentId,
    );
    setVoiceStatusLoading(set, environmentId, requestStartedAt);

    try {
      const snapshot = await bridge.getEnvironmentVoiceStatus(environmentId);
      if (isVoiceStatusFetchStale(get, environmentId, requestStartedAt)) {
        return;
      }
      setVoiceStatusSnapshot(set, environmentId, snapshot, requestStartedAt);
    } catch (cause: unknown) {
      if (isVoiceStatusFetchStale(get, environmentId, requestStartedAt)) {
        return;
      }
      const message =
        cause instanceof Error ? cause.message : "Failed to load voice status";
      setVoiceStatusError(set, environmentId, message, requestStartedAt);
    }
  },
}));

function setVoiceStatusLoading(
  set: VoiceStatusSet,
  environmentId: string,
  requestStartedAt: number,
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
    lastRequestedAtByEnvironmentId: {
      ...state.lastRequestedAtByEnvironmentId,
      [environmentId]: requestStartedAt,
    },
  }));
}

function setVoiceStatusSnapshot(
  set: VoiceStatusSet,
  environmentId: string,
  snapshot: EnvironmentVoiceStatusSnapshot,
  requestStartedAt: number,
) {
  const fetchedAt = Date.now();
  set((state) => {
    if (
      state.lastRequestedAtByEnvironmentId[environmentId] !== requestStartedAt
    ) {
      return {};
    }

    return {
      snapshotsByEnvironmentId: {
        ...state.snapshotsByEnvironmentId,
        [environmentId]: snapshot,
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
    };
  });
}

function setVoiceStatusError(
  set: VoiceStatusSet,
  environmentId: string,
  message: string,
  requestStartedAt: number,
) {
  set((state) => {
    if (
      state.lastRequestedAtByEnvironmentId[environmentId] !== requestStartedAt
    ) {
      return {};
    }

    return {
      snapshotsByEnvironmentId: {
        ...state.snapshotsByEnvironmentId,
        [environmentId]: null,
      },
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
    };
  });
}

function nextVoiceStatusRequestStartedAt(
  state: VoiceStatusState,
  environmentId: string,
) {
  const now = Date.now();
  const previousRequestStartedAt =
    state.lastRequestedAtByEnvironmentId[environmentId] ??
    Number.NEGATIVE_INFINITY;
  return now > previousRequestStartedAt ? now : previousRequestStartedAt + 1;
}

function isVoiceStatusFetchStale(
  get: () => VoiceStatusState,
  environmentId: string,
  requestStartedAt: number,
) {
  return (
    get().lastRequestedAtByEnvironmentId[environmentId] !== requestStartedAt
  );
}
