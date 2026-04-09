import { confirm } from "@tauri-apps/plugin-dialog";

import * as bridge from "../../lib/bridge";
import type { EnvironmentRecord, WorkspaceSnapshot } from "../../lib/types";
import { useVoiceSessionStore } from "../../stores/voice-session-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

export async function createThreadForSelection() {
  const environment = selectedEnvironment();
  if (!environment) {
    return false;
  }

  const thread = await bridge.createThread({ environmentId: environment.id });
  const refreshed = await useWorkspaceStore.getState().refreshSnapshot();
  if (!refreshed) {
    return false;
  }
  useWorkspaceStore.getState().selectThread(thread.id);
  return true;
}

export async function createManagedWorktreeForSelection() {
  const projectId = selectedProjectId();
  if (!projectId) {
    return false;
  }

  const result = await bridge.createManagedWorktree(projectId);
  const refreshed = await useWorkspaceStore.getState().refreshSnapshot();
  if (!refreshed) {
    return false;
  }
  useWorkspaceStore.getState().selectThread(result.thread.id);
  return true;
}

export async function archiveThreadWithConfirmation(threadId: string) {
  const snapshot = useWorkspaceStore.getState().snapshot;
  const target = findThread(snapshot, threadId);
  if (!target || ownsPendingVoiceWork(threadId)) {
    return false;
  }

  const confirmed = await confirm("Are you sure you want to archive this thread?", {
    title: "Archive Thread",
    kind: "warning",
    okLabel: "Archive",
    cancelLabel: "Cancel",
  });
  if (!confirmed) {
    return false;
  }

  await bridge.archiveThread({ threadId: target.thread.id });
  return await useWorkspaceStore.getState().refreshSnapshot();
}

export function selectAdjacentThread(direction: "next" | "previous") {
  const environment = selectedEnvironment();
  if (!environment) {
    return false;
  }

  const activeThreads = environment.threads.filter((thread) => thread.status === "active");
  if (activeThreads.length === 0) {
    return false;
  }

  const currentIndex = activeThreads.findIndex(
    (thread) => thread.id === useWorkspaceStore.getState().selectedThreadId,
  );
  const baseIndex =
    currentIndex === -1 ? (direction === "next" ? -1 : 0) : currentIndex;
  const offset = direction === "next" ? 1 : -1;
  const nextIndex = (baseIndex + offset + activeThreads.length) % activeThreads.length;
  const nextThread = activeThreads[nextIndex];
  if (!nextThread) {
    return false;
  }

  useWorkspaceStore.getState().selectThread(nextThread.id);
  return true;
}

export function selectAdjacentEnvironment(direction: "next" | "previous") {
  const snapshot = useWorkspaceStore.getState().snapshot;
  const selectedEnvironmentId = useWorkspaceStore.getState().selectedEnvironmentId;
  const orderedEnvironments = listOrderedEnvironments(snapshot);
  if (orderedEnvironments.length === 0) {
    return false;
  }

  const currentIndex = orderedEnvironments.findIndex(
    (environment) => environment.id === selectedEnvironmentId,
  );
  const baseIndex =
    currentIndex === -1 ? (direction === "next" ? -1 : 0) : currentIndex;
  const offset = direction === "next" ? 1 : -1;
  const nextIndex =
    (baseIndex + offset + orderedEnvironments.length) % orderedEnvironments.length;
  const nextEnvironment = orderedEnvironments[nextIndex];
  if (!nextEnvironment) {
    return false;
  }

  useWorkspaceStore.getState().selectEnvironment(nextEnvironment.id);
  return true;
}

function selectedEnvironment() {
  const snapshot = useWorkspaceStore.getState().snapshot;
  const selectedEnvironmentId = useWorkspaceStore.getState().selectedEnvironmentId;
  if (!snapshot || !selectedEnvironmentId) {
    return null;
  }
  return listOrderedEnvironments(snapshot).find(
    (environment) => environment.id === selectedEnvironmentId,
  ) ?? null;
}

function selectedProjectId() {
  const state = useWorkspaceStore.getState();
  if (state.selectedProjectId) {
    return state.selectedProjectId;
  }
  if (state.snapshot && state.selectedEnvironmentId) {
    for (const project of state.snapshot.projects) {
      if (project.environments.some((environment) => environment.id === state.selectedEnvironmentId)) {
        return project.id;
      }
    }
  }
  return null;
}

function findThread(snapshot: WorkspaceSnapshot | null, threadId: string) {
  if (!snapshot) {
    return null;
  }
  for (const project of snapshot.projects) {
    for (const environment of project.environments) {
      const thread = environment.threads.find((candidate) => candidate.id === threadId);
      if (thread) {
        return { project, environment, thread };
      }
    }
  }
  return null;
}

function listOrderedEnvironments(snapshot: WorkspaceSnapshot | null): EnvironmentRecord[] {
  if (!snapshot) {
    return [];
  }
  return snapshot.projects.flatMap((project) => {
    const environments = [...project.environments];
    environments.sort(compareEnvironmentOrder);
    return environments;
  });
}

function compareEnvironmentOrder(left: EnvironmentRecord, right: EnvironmentRecord) {
  if (left.kind === "local" && right.kind !== "local") {
    return -1;
  }
  if (left.kind !== "local" && right.kind === "local") {
    return 1;
  }
  if (left.isDefault && !right.isDefault) {
    return -1;
  }
  if (!left.isDefault && right.isDefault) {
    return 1;
  }
  return left.createdAt.localeCompare(right.createdAt);
}

function ownsPendingVoiceWork(threadId: string) {
  const state = useVoiceSessionStore.getState();
  return (
    state.ownerThreadId === threadId &&
    (state.phase !== "idle" || state.pendingOutcomesByThreadId[threadId] != null)
  );
}
