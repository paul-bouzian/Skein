import { create } from "zustand";

import * as bridge from "../lib/bridge";
import type {
  BootstrapStatus,
  EnvironmentRecord,
  GlobalSettings,
  ProjectRecord,
  ThreadRecord,
  WorkspaceSnapshot,
} from "../lib/types";

type LoadingState = "idle" | "loading" | "ready" | "error";

type WorkspaceState = {
  snapshot: WorkspaceSnapshot | null;
  bootstrapStatus: BootstrapStatus | null;
  loadingState: LoadingState;
  error: string | null;

  selectedProjectId: string | null;
  selectedEnvironmentId: string | null;
  selectedThreadId: string | null;

  initialize: () => Promise<void>;
  refreshSnapshot: () => Promise<void>;
  selectProject: (id: string | null) => void;
  selectEnvironment: (id: string | null) => void;
  selectThread: (id: string | null) => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  snapshot: null,
  bootstrapStatus: null,
  loadingState: "idle",
  error: null,

  selectedProjectId: null,
  selectedEnvironmentId: null,
  selectedThreadId: null,

  initialize: async () => {
    if (get().loadingState === "loading") return;
    set({ loadingState: "loading", error: null });
    try {
      const [bootstrapStatus, snapshot] = await Promise.all([
        bridge.getBootstrapStatus(),
        bridge.getWorkspaceSnapshot(),
      ]);
      set((state) => ({
        bootstrapStatus,
        snapshot,
        loadingState: "ready",
        ...reconcileSelection(snapshot, state),
      }));
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to load workspace";
      set({ loadingState: "error", error: message });
    }
  },

  refreshSnapshot: async () => {
    try {
      const snapshot = await bridge.getWorkspaceSnapshot();
      set((state) => ({
        snapshot,
        ...reconcileSelection(snapshot, state),
      }));
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to refresh workspace";
      set({ error: message });
    }
  },

  selectProject: (id) =>
    set({
      selectedProjectId: id,
      selectedEnvironmentId: null,
      selectedThreadId: null,
    }),

  selectEnvironment: (id) =>
    set((state) => selectEnvironmentState(state.snapshot, id)),

  selectThread: (id) =>
    set((state) => {
      if (!id || !state.snapshot) {
        return { selectedThreadId: id };
      }

      const selectedThread = findThread(state.snapshot, id);
      if (!selectedThread) {
        return { selectedThreadId: null };
      }

      return {
        selectedProjectId: selectedThread.project.id,
        selectedEnvironmentId: selectedThread.environment.id,
        selectedThreadId: selectedThread.thread.id,
      };
    }),
}));

/* ── Derived selectors ── */

export function selectProjects(s: WorkspaceState): ProjectRecord[] {
  return s.snapshot?.projects ?? [];
}

export function selectSettings(s: WorkspaceState): GlobalSettings | null {
  return s.snapshot?.settings ?? null;
}

export function selectSelectedProject(
  s: WorkspaceState,
): ProjectRecord | null {
  if (!s.selectedProjectId || !s.snapshot) return null;
  return (
    s.snapshot.projects.find((p) => p.id === s.selectedProjectId) ?? null
  );
}

export function selectSelectedEnvironment(
  s: WorkspaceState,
): EnvironmentRecord | null {
  if (!s.selectedEnvironmentId || !s.snapshot) return null;
  for (const project of s.snapshot.projects) {
    const env = project.environments.find(
      (e) => e.id === s.selectedEnvironmentId,
    );
    if (env) return env;
  }
  return null;
}

export function selectSelectedThread(
  s: WorkspaceState,
): ThreadRecord | null {
  if (!s.selectedThreadId || !s.snapshot) return null;
  for (const project of s.snapshot.projects) {
    for (const env of project.environments) {
      const thread = env.threads.find((t) => t.id === s.selectedThreadId);
      if (thread) return thread;
    }
  }
  return null;
}

function reconcileSelection(
  snapshot: WorkspaceSnapshot,
  state: Pick<
    WorkspaceState,
    "selectedProjectId" | "selectedEnvironmentId" | "selectedThreadId"
  >,
) {
  const selectedEnvironment = findEnvironment(snapshot, state.selectedEnvironmentId);
  const selectedThread = findThread(snapshot, state.selectedThreadId);
  const fallbackThread = selectedEnvironment
    ? findLatestActiveThread(selectedEnvironment.environment)
    : null;

  const selectedProjectId =
    findProject(snapshot, state.selectedProjectId)?.id ??
    selectedEnvironment?.project.id ??
    selectedThread?.project.id ??
    null;

  const selectedEnvironmentId =
    selectedEnvironment?.environment.id ??
    selectedThread?.environment.id ??
    null;

  const selectedThreadId = selectedThread?.thread.id ?? fallbackThread?.id ?? null;

  return {
    selectedProjectId,
    selectedEnvironmentId,
    selectedThreadId,
  };
}

function selectEnvironmentState(
  snapshot: WorkspaceSnapshot | null,
  environmentId: string | null,
) {
  if (!snapshot || !environmentId) {
    return {
      selectedEnvironmentId: environmentId,
      selectedThreadId: null,
    };
  }

  const selectedEnvironment = findEnvironment(snapshot, environmentId);
  if (!selectedEnvironment) {
    return {
      selectedEnvironmentId: null,
      selectedThreadId: null,
    };
  }

  return {
    selectedProjectId: selectedEnvironment.project.id,
    selectedEnvironmentId: selectedEnvironment.environment.id,
    selectedThreadId: findLatestActiveThread(selectedEnvironment.environment)?.id ?? null,
  };
}

function findProject(snapshot: WorkspaceSnapshot, projectId: string | null) {
  if (!projectId) return null;
  return snapshot.projects.find((project) => project.id === projectId) ?? null;
}

function findEnvironment(snapshot: WorkspaceSnapshot, environmentId: string | null) {
  if (!environmentId) return null;
  for (const project of snapshot.projects) {
    const environment = project.environments.find((candidate) => candidate.id === environmentId);
    if (environment) {
      return { environment, project };
    }
  }
  return null;
}

function findLatestActiveThread(environment: EnvironmentRecord) {
  return [...environment.threads]
    .filter((thread) => thread.status === "active")
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ?? null;
}

function findThread(snapshot: WorkspaceSnapshot, threadId: string | null) {
  if (!threadId) return null;
  for (const project of snapshot.projects) {
    for (const environment of project.environments) {
      const thread = environment.threads.find((candidate) => candidate.id === threadId);
      if (thread) {
        return { thread, environment, project };
      }
    }
  }
  return null;
}
