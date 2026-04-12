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
import { useTerminalStore } from "./terminal-store";

type LoadingState = "idle" | "loading" | "ready" | "error";

type WorkspaceMutationResult = {
  ok: boolean;
  refreshed: boolean;
  warningMessage: string | null;
  errorMessage: string | null;
};

type WorkspaceSettingsMutationResult = WorkspaceMutationResult & {
  settings: GlobalSettings | null;
};

type WorkspaceStateUpdate =
  | Partial<WorkspaceState>
  | WorkspaceState
  | ((state: WorkspaceState) => Partial<WorkspaceState> | WorkspaceState);

type WorkspaceSetter = (partial: WorkspaceStateUpdate) => void;
const WORKSPACE_REFRESH_DEBOUNCE_MS = 200;

type WorkspaceState = {
  snapshot: WorkspaceSnapshot | null;
  bootstrapStatus: BootstrapStatus | null;
  loadingState: LoadingState;
  error: string | null;
  listenerReady: boolean;

  selectedProjectId: string | null;
  selectedEnvironmentId: string | null;
  selectedThreadId: string | null;

  initialize: () => Promise<void>;
  initializeListener: () => Promise<void>;
  refreshSnapshot: () => Promise<boolean>;
  updateGlobalSettings: (
    patch: Parameters<typeof bridge.updateGlobalSettings>[0],
  ) => Promise<WorkspaceSettingsMutationResult>;
  removeThread: (threadId: string) => boolean;
  reorderProjects: (projectIds: string[]) => Promise<WorkspaceMutationResult>;
  reorderWorktreeEnvironments: (
    projectId: string,
    environmentIds: string[],
  ) => Promise<WorkspaceMutationResult>;
  setProjectSidebarCollapsed: (
    projectId: string,
    collapsed: boolean,
  ) => Promise<WorkspaceMutationResult>;
  selectProject: (id: string | null) => void;
  selectEnvironment: (id: string | null) => void;
  selectThread: (id: string | null) => void;
};

let unlistenWorkspaceEvents: null | (() => void) = null;
let listenerInitialization: Promise<void> | null = null;
let listenerGeneration = 0;
let refreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let inflightRefresh: Promise<boolean> | null = null;
let queuedRefresh = false;

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  snapshot: null,
  bootstrapStatus: null,
  loadingState: "idle",
  error: null,
  listenerReady: false,

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
      useTerminalStore.getState().syncWorkspaceSnapshot(snapshot);
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

  initializeListener: async () => {
    if (get().listenerReady) return;
    if (listenerInitialization) {
      await listenerInitialization;
      return;
    }

    const generation = listenerGeneration;
    const initialization = bridge
      .listenToWorkspaceEvents(() => {
        scheduleWorkspaceRefresh(get);
      })
      .then((unlisten) => {
        if (generation !== listenerGeneration) {
          unlisten();
          return;
        }

        unlistenWorkspaceEvents = unlisten;
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

  refreshSnapshot: async () => {
    try {
      const snapshot = await bridge.getWorkspaceSnapshot();
      useTerminalStore.getState().syncWorkspaceSnapshot(snapshot);
      set((state) => ({
        snapshot,
        ...reconcileSelection(snapshot, state),
      }));
      return true;
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to refresh workspace";
      set({ error: message });
      return false;
    }
  },

  updateGlobalSettings: async (patch) => {
    let settings: GlobalSettings;
    try {
      settings = await bridge.updateGlobalSettings(patch);
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Failed to save settings";
      set({ error: message });
      return {
        ok: false,
        refreshed: false,
        warningMessage: null,
        errorMessage: message,
        settings: null,
      };
    }

    applySnapshotMutation(set, (snapshot) => ({
      ...snapshot,
      settings,
    }));

    if (await get().refreshSnapshot()) {
      set({ error: null });
      return {
        ok: true,
        refreshed: true,
        warningMessage: null,
        errorMessage: null,
        settings,
      };
    }

    const warningMessage =
      "Settings were saved, but the workspace snapshot could not be refreshed.";
    set({ error: warningMessage });
    return {
      ok: true,
      refreshed: false,
      warningMessage,
      errorMessage: null,
      settings,
    };
  },

  removeThread: (threadId) => {
    let removed = false;
    set((state) => {
      const nextSnapshot = removeThreadFromSnapshot(state.snapshot, threadId);
      if (!nextSnapshot || nextSnapshot === state.snapshot) {
        return state;
      }

      removed = true;
      return {
        snapshot: nextSnapshot,
        ...reconcileSelection(nextSnapshot, state),
      };
    });
    return removed;
  },

  reorderProjects: async (projectIds) => {
    return runWorkspaceMutation(
      set,
      get,
      {
        run: () => bridge.reorderProjects({ projectIds }),
        applySnapshot: (snapshot) => reorderProjectsInSnapshot(snapshot, projectIds),
        writeFailureMessage: "Failed to reorder projects",
        refreshFailureMessage:
          "Project order saved, but the workspace failed to refresh.",
      },
    );
  },

  reorderWorktreeEnvironments: async (projectId, environmentIds) => {
    return runWorkspaceMutation(
      set,
      get,
      {
        run: () => bridge.reorderWorktreeEnvironments({ projectId, environmentIds }),
        applySnapshot: (snapshot) =>
          reorderWorktreeEnvironmentsInSnapshot(
            snapshot,
            projectId,
            environmentIds,
          ),
        writeFailureMessage: "Failed to reorder worktrees",
        refreshFailureMessage:
          "Worktree order saved, but the workspace failed to refresh.",
      },
    );
  },

  setProjectSidebarCollapsed: async (projectId, collapsed) => {
    return runWorkspaceMutation(
      set,
      get,
      {
        run: () => bridge.setProjectSidebarCollapsed({ projectId, collapsed }),
        applySnapshot: (snapshot) =>
          setProjectSidebarCollapsedInSnapshot(snapshot, projectId, collapsed),
        writeFailureMessage: "Failed to update project collapse state",
        refreshFailureMessage:
          "Project collapse state saved, but the workspace failed to refresh.",
      },
    );
  },

  selectProject: (id) =>
    set((state) => selectProjectState(state.snapshot, id)),

  selectEnvironment: (id) =>
    set((state) => selectEnvironmentState(state.snapshot, id)),

  selectThread: (id) =>
    set((state) => {
      if (!id || !state.snapshot) {
        return { selectedThreadId: id };
      }

      const selectedThread = findThreadInWorkspace(state.snapshot, id);
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

export function teardownWorkspaceListener() {
  listenerGeneration += 1;
  unlistenWorkspaceEvents?.();
  unlistenWorkspaceEvents = null;
  listenerInitialization = null;
  if (refreshTimer !== null) {
    globalThis.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  inflightRefresh = null;
  queuedRefresh = false;
  useWorkspaceStore.setState({ listenerReady: false });
}

export function requestWorkspaceRefresh() {
  scheduleWorkspaceRefresh(useWorkspaceStore.getState);
}

function scheduleWorkspaceRefresh(get: () => WorkspaceState) {
  if (refreshTimer !== null) {
    globalThis.clearTimeout(refreshTimer);
  }

  refreshTimer = globalThis.setTimeout(() => {
    refreshTimer = null;
    void runWorkspaceRefresh(get).catch(() => undefined);
  }, WORKSPACE_REFRESH_DEBOUNCE_MS);
}

async function runWorkspaceRefresh(get: () => WorkspaceState): Promise<boolean> {
  if (inflightRefresh) {
    queuedRefresh = true;
    return inflightRefresh;
  }

  const request = get().refreshSnapshot();
  inflightRefresh = request;

  try {
    return await request;
  } finally {
    if (inflightRefresh === request) {
      inflightRefresh = null;
    }

    if (queuedRefresh) {
      queuedRefresh = false;
      scheduleWorkspaceRefresh(get);
    }
  }
}

/* ── Derived selectors ── */

export function selectProjects(s: WorkspaceState): ProjectRecord[] {
  return s.snapshot?.projects ?? [];
}

async function runWorkspaceMutation(
  set: WorkspaceSetter,
  get: () => WorkspaceState,
  options: {
    run: () => Promise<void>;
    applySnapshot: (snapshot: WorkspaceSnapshot) => WorkspaceSnapshot;
    writeFailureMessage: string;
    refreshFailureMessage: string;
  },
): Promise<WorkspaceMutationResult> {
  try {
    await options.run();
  } catch (cause: unknown) {
    const message =
      cause instanceof Error ? cause.message : options.writeFailureMessage;
    set({ error: message });
    return {
      ok: false,
      refreshed: false,
      warningMessage: null,
      errorMessage: message,
    };
  }

  applySnapshotMutation(set, options.applySnapshot);

  if (await get().refreshSnapshot()) {
    set({ error: null });
    return {
      ok: true,
      refreshed: true,
      warningMessage: null,
      errorMessage: null,
    };
  }

  set({ error: options.refreshFailureMessage });
  return {
    ok: true,
    refreshed: false,
    warningMessage: options.refreshFailureMessage,
    errorMessage: null,
  };
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

export function selectEnvironmentRuntimeState(environmentId: string | null) {
  return (state: WorkspaceState) =>
    getEnvironmentRuntimeState(state.snapshot, environmentId);
}

export function getEnvironmentRuntimeState(
  snapshot: WorkspaceSnapshot | null,
  environmentId: string | null,
) {
  return findEnvironment(snapshot, environmentId)?.environment.runtime.state ?? null;
}

function reconcileSelection(
  snapshot: WorkspaceSnapshot,
  state: Pick<
    WorkspaceState,
    "selectedProjectId" | "selectedEnvironmentId" | "selectedThreadId"
  >,
) {
  const selectedProject = findProject(snapshot, state.selectedProjectId);
  const selectedEnvironment = findEnvironment(snapshot, state.selectedEnvironmentId);
  const selectedThread = findThreadInWorkspace(snapshot, state.selectedThreadId);
  const fallbackEnvironment = selectedProject
    ? findPrimaryEnvironment(selectedProject)
    : null;
  const fallbackThread = selectedEnvironment
    ? findLatestActiveThread(selectedEnvironment.environment)
    : fallbackEnvironment
      ? findLatestActiveThread(fallbackEnvironment)
    : null;

  const selectedProjectId =
    selectedProject?.id ??
    selectedEnvironment?.project.id ??
    selectedThread?.project.id ??
    null;

  const selectedEnvironmentId =
    selectedEnvironment?.environment.id ??
    selectedThread?.environment.id ??
    fallbackEnvironment?.id ??
    null;

  const selectedThreadId = selectedThread?.thread.id ?? fallbackThread?.id ?? null;

  return {
    selectedProjectId,
    selectedEnvironmentId,
    selectedThreadId,
  };
}

function selectProjectState(
  snapshot: WorkspaceSnapshot | null,
  projectId: string | null,
) {
  if (!snapshot || !projectId) {
    return {
      selectedProjectId: projectId,
      selectedEnvironmentId: null,
      selectedThreadId: null,
    };
  }

  const project = findProject(snapshot, projectId);
  const environment = project ? findPrimaryEnvironment(project) : null;
  return {
    selectedProjectId: project?.id ?? null,
    selectedEnvironmentId: environment?.id ?? null,
    selectedThreadId: environment ? findLatestActiveThread(environment)?.id ?? null : null,
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

function findPrimaryEnvironment(project: ProjectRecord) {
  return (
    project.environments.find((environment) => environment.kind === "local") ??
    project.environments.find((environment) => environment.isDefault) ??
    project.environments[0] ??
    null
  );
}

function findEnvironment(
  snapshot: WorkspaceSnapshot | null,
  environmentId: string | null,
) {
  if (!environmentId) return null;
  if (!snapshot) return null;
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

export function findThreadInWorkspace(
  snapshot: WorkspaceSnapshot | null,
  threadId: string | null,
) {
  if (!snapshot || !threadId) return null;
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

function removeThreadFromSnapshot(
  snapshot: WorkspaceSnapshot | null,
  threadId: string,
) {
  if (!snapshot) {
    return null;
  }

  let removed = false;
  const nextProjects = snapshot.projects.map((project) => {
    let projectChanged = false;
    const nextEnvironments = project.environments.map((environment) => {
      const nextThreads = environment.threads.filter((thread) => thread.id !== threadId);
      if (nextThreads.length === environment.threads.length) {
        return environment;
      }

      removed = true;
      projectChanged = true;
      return {
        ...environment,
        threads: nextThreads,
      };
    });

    if (!projectChanged) {
      return project;
    }

    return {
      ...project,
      environments: nextEnvironments,
    };
  });

  return removed
    ? {
        ...snapshot,
        projects: nextProjects,
      }
    : snapshot;
}

function applySnapshotMutation(
  set: WorkspaceSetter,
  applySnapshot: (snapshot: WorkspaceSnapshot) => WorkspaceSnapshot,
) {
  set((state) => {
    if (!state.snapshot) {
      return { error: null };
    }

    const nextSnapshot = applySnapshot(state.snapshot);
    if (nextSnapshot === state.snapshot) {
      return { error: null };
    }

    return {
      snapshot: nextSnapshot,
      error: null,
      ...reconcileSelection(nextSnapshot, state),
    };
  });
}

function reorderProjectsInSnapshot(
  snapshot: WorkspaceSnapshot,
  projectIds: string[],
) {
  const nextProjects = reorderRecordsById(snapshot.projects, projectIds);
  if (!nextProjects) {
    return snapshot;
  }

  return {
    ...snapshot,
    projects: nextProjects,
  };
}

function reorderWorktreeEnvironmentsInSnapshot(
  snapshot: WorkspaceSnapshot,
  projectId: string,
  environmentIds: string[],
) {
  let changed = false;
  const nextProjects = snapshot.projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }

    const localEnvironments = project.environments.filter(
      (environment) => environment.kind === "local",
    );
    const worktreeEnvironments = project.environments.filter(
      (environment) => environment.kind !== "local",
    );
    const reorderedWorktrees = reorderRecordsById(
      worktreeEnvironments,
      environmentIds,
    );
    if (!reorderedWorktrees) {
      return project;
    }

    changed = true;
    return {
      ...project,
      environments: [...localEnvironments, ...reorderedWorktrees],
    };
  });

  return changed
    ? {
        ...snapshot,
        projects: nextProjects,
      }
    : snapshot;
}

function setProjectSidebarCollapsedInSnapshot(
  snapshot: WorkspaceSnapshot,
  projectId: string,
  collapsed: boolean,
) {
  let changed = false;
  const nextProjects = snapshot.projects.map((project) => {
    if (project.id !== projectId || project.sidebarCollapsed === collapsed) {
      return project;
    }

    changed = true;
    return {
      ...project,
      sidebarCollapsed: collapsed,
    };
  });

  return changed
    ? {
        ...snapshot,
        projects: nextProjects,
      }
    : snapshot;
}

function reorderRecordsById<RecordType extends { id: string }>(
  records: RecordType[],
  ids: string[],
) {
  if (records.length !== ids.length) {
    return null;
  }

  const recordsById = new Map(records.map((record) => [record.id, record]));
  const orderedRecords = ids
    .map((id) => recordsById.get(id))
    .filter((record): record is RecordType => record != null);

  if (orderedRecords.length !== records.length) {
    return null;
  }

  return orderedRecords;
}
