import type {
  ConversationInteraction,
  ThreadConversationSnapshot,
} from "./types";

export type DesktopNotificationAttentionKind = "approval" | "userInput" | "plan";

export type DesktopNotificationCandidate =
  | {
      threadId: string;
      kind: "completed";
    }
  | {
      threadId: string;
      kind: "attention";
      attentionKind: DesktopNotificationAttentionKind;
      attentionKey: string;
    };

type AttentionSource = {
  kind: DesktopNotificationAttentionKind;
  key: string;
};

function hasAwaitingPlanDecision(snapshot: ThreadConversationSnapshot): boolean {
  return snapshot.proposedPlan?.isAwaitingDecision === true;
}

function isFirstClassInteraction(
  interaction: ConversationInteraction,
): interaction is Extract<ConversationInteraction, { kind: "approval" | "userInput" }> {
  return interaction.kind === "approval" || interaction.kind === "userInput";
}

function resolveAttentionSource(
  snapshot: ThreadConversationSnapshot | null | undefined,
): AttentionSource | null {
  if (!snapshot) {
    return null;
  }

  const interaction = snapshot.pendingInteractions.find(isFirstClassInteraction);
  if (interaction?.kind === "approval") {
    return {
      kind: "approval",
      key: `approval:${interaction.id}`,
    };
  }
  if (interaction?.kind === "userInput") {
    return {
      kind: "userInput",
      key: `userInput:${interaction.id}`,
    };
  }
  if (hasAwaitingPlanDecision(snapshot)) {
    const turnId = snapshot.proposedPlan?.turnId ?? "unknown";
    const itemId = snapshot.proposedPlan?.itemId?.trim() || "turn";
    return {
      kind: "plan",
      key: `plan:${turnId}:${itemId}`,
    };
  }

  return null;
}

function wasActivelyWorking(snapshot: ThreadConversationSnapshot | null | undefined): boolean {
  if (!snapshot) {
    return false;
  }

  return snapshot.status === "running" || snapshot.activeTurnId != null;
}

function isCompletedSnapshot(snapshot: ThreadConversationSnapshot): boolean {
  return (
    snapshot.status === "completed" &&
    snapshot.activeTurnId == null &&
    snapshot.pendingInteractions.length === 0 &&
    !hasAwaitingPlanDecision(snapshot)
  );
}

export function collectDesktopNotificationCandidates(
  previousSnapshotsByThreadId: Record<string, ThreadConversationSnapshot>,
  nextSnapshotsByThreadId: Record<string, ThreadConversationSnapshot>,
  options?: {
    suppressUnknownThreads?: boolean;
    threadIds?: readonly string[];
  },
): DesktopNotificationCandidate[] {
  const candidates: DesktopNotificationCandidate[] = [];
  const suppressUnknownThreads = options?.suppressUnknownThreads === true;
  const threadIds = options?.threadIds ?? Object.keys(nextSnapshotsByThreadId).sort();

  for (const threadId of threadIds) {
    const previousSnapshot = previousSnapshotsByThreadId[threadId];
    const nextSnapshot = nextSnapshotsByThreadId[threadId];
    if (!nextSnapshot) {
      continue;
    }

    if (previousSnapshot === nextSnapshot) {
      continue;
    }

    if (suppressUnknownThreads && !previousSnapshot) {
      continue;
    }

    if (
      wasActivelyWorking(previousSnapshot) &&
      isCompletedSnapshot(nextSnapshot)
    ) {
      candidates.push({
        threadId,
        kind: "completed",
      });
    }

    const previousAttention = resolveAttentionSource(previousSnapshot);
    const nextAttention = resolveAttentionSource(nextSnapshot);
    if (!nextAttention || previousAttention?.key === nextAttention.key) {
      continue;
    }

    candidates.push({
      threadId,
      kind: "attention",
      attentionKind: nextAttention.kind,
      attentionKey: nextAttention.key,
    });
  }

  return candidates;
}
