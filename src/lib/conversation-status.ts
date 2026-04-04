import type {
  ConversationStatus,
  EnvironmentRecord,
  RuntimeState,
  ThreadConversationSnapshot,
} from "./types";

export type ConversationStatusTone =
  | "neutral"
  | "running"
  | "completed"
  | "warning"
  | "failed"
  | "waiting";

export type ConversationIndicatorTone =
  | "neutral"
  | "progress"
  | "completed"
  | "warning"
  | "failed"
  | "waiting";

export function labelForConversationStatus(status: ConversationStatus): string {
  switch (status) {
    case "waitingForExternalAction":
      return "Awaiting action";
    case "idle":
      return "Idle";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
  }
}

export function toneForConversationStatus(status: ConversationStatus): ConversationStatusTone {
  switch (status) {
    case "waitingForExternalAction":
      return "waiting";
    case "idle":
      return "neutral";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "interrupted":
      return "neutral";
    case "failed":
      return "failed";
  }
}

export function indicatorToneForConversationStatus(
  status: ConversationStatus,
): ConversationIndicatorTone {
  switch (status) {
    case "waitingForExternalAction":
      return "waiting";
    case "idle":
      return "neutral";
    case "running":
      return "progress";
    case "completed":
      return "completed";
    case "interrupted":
      return "neutral";
    case "failed":
      return "failed";
  }
}

export function deriveEnvironmentConversationStatus(
  environment: EnvironmentRecord,
  snapshotsByThreadId: Record<string, ThreadConversationSnapshot>,
): ConversationStatus {
  const activeThreadIds = environment.threads
    .filter((thread) => thread.status === "active")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => thread.id);
  const statuses = activeThreadIds
    .map((threadId) => snapshotsByThreadId[threadId]?.status)
    .filter((status): status is ConversationStatus => Boolean(status));

  if (statuses.includes("waitingForExternalAction")) {
    return "waitingForExternalAction";
  }
  if (statuses.includes("running")) {
    return "running";
  }
  if (
    statuses.length > 0 &&
    statuses.length === activeThreadIds.length &&
    statuses.every((status) => status === "completed")
  ) {
    return "completed";
  }
  if (statuses.includes("failed")) {
    return "failed";
  }
  if (statuses.includes("interrupted")) {
    return "interrupted";
  }
  if (statuses.includes("idle")) {
    return "idle";
  }

  return fallbackConversationStatus(environment.runtime.state);
}

function fallbackConversationStatus(runtimeState: RuntimeState): ConversationStatus {
  switch (runtimeState) {
    case "running":
      return "running";
    case "exited":
      return "interrupted";
    case "stopped":
      return "idle";
  }
}
