import type {
  ConversationItem,
  ConversationStatus,
  ConversationTaskSnapshot,
  ProposedPlanSnapshot,
  ThreadConversationSnapshot,
} from "../../lib/types";
import { shouldRenderConversationItem } from "./conversation-item-visibility";

export type WorkActivityStatus =
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed";

export type ConversationWorkActivityGroup = {
  id: string;
  turnId: string;
  items: ConversationItem[];
  counts: {
    updateCount: number;
    reasoningCount: number;
    toolCount: number;
    systemCount: number;
  };
  status: WorkActivityStatus;
  startedAt: number | null;
  finishedAt: number | null;
};

type WorkActivityTiming = {
  startedAt: number;
  finishedAt: number | null;
};

const TIMING_BY_TURN: Map<string, WorkActivityTiming> = new Map();
const TIMING_MAX_ENTRIES = 500;

function evictOldestTiming(): void {
  while (TIMING_BY_TURN.size > TIMING_MAX_ENTRIES) {
    const oldest = TIMING_BY_TURN.keys().next().value;
    if (oldest === undefined) break;
    TIMING_BY_TURN.delete(oldest);
  }
}

function recordTiming(
  turnId: string,
  status: WorkActivityStatus,
): WorkActivityTiming | null {
  const existing = TIMING_BY_TURN.get(turnId) ?? null;
  if (status === "running" || status === "waiting") {
    if (existing) {
      existing.finishedAt = null;
      return existing;
    }
    const created: WorkActivityTiming = { startedAt: Date.now(), finishedAt: null };
    TIMING_BY_TURN.set(turnId, created);
    evictOldestTiming();
    return created;
  }
  if (!existing) return null;
  if (existing.finishedAt === null) {
    existing.finishedAt = Date.now();
  }
  return existing;
}

export type ConversationTimelineEntry =
  | {
      kind: "item";
      item: ConversationItem;
    }
  | {
      kind: "workActivity";
      group: ConversationWorkActivityGroup;
    };

type MutableGroup = {
  turnId: string;
  items: ConversationItem[];
};

export function hasRenderableTaskPlan(taskPlan?: ConversationTaskSnapshot | null) {
  return Boolean(
    taskPlan &&
      (taskPlan.steps.length > 0 ||
        taskPlan.markdown.trim().length > 0 ||
        taskPlan.explanation.trim().length > 0),
  );
}

export function shouldRenderProposedPlan(plan?: ProposedPlanSnapshot | null) {
  return Boolean(plan && (plan.isAwaitingDecision || plan.status === "streaming"));
}

export function buildConversationTimeline(
  snapshot: ThreadConversationSnapshot,
): ConversationTimelineEntry[] {
  const groupsByTurn = new Map<string, MutableGroup>();
  const actionTurnIds = collectActionTurnIds(snapshot);
  const assistantSuppressedTurnIds = collectAssistantSuppressedTurnIds(snapshot);
  const effectiveTurnIds = inferEffectiveTurnIds(snapshot);
  const actionAssistantMessageIds = collectAssistantMessageIdsForTurns(
    snapshot.items,
    effectiveTurnIds,
    assistantSuppressedTurnIds,
  );
  const latestWorkTurnId = findLatestWorkTurnId(snapshot, effectiveTurnIds);
  const finalAssistantMessageIds = collectFinalAssistantMessageIds(
    snapshot,
    snapshot.items,
    effectiveTurnIds,
    actionTurnIds,
  );

  for (const item of snapshot.items) {
    const turnId = effectiveTurnIds.get(item.id) ?? null;
    if (
      actionAssistantMessageIds.has(item.id) ||
      !turnId ||
      !shouldRenderConversationItem(item) ||
      !isGroupedWorkItem(item, turnId, finalAssistantMessageIds)
    ) {
      continue;
    }
    getOrCreateGroup(groupsByTurn, turnId).items.push(item);
  }

  if (snapshot.activeTurnId) {
    getOrCreateGroup(groupsByTurn, snapshot.activeTurnId);
  }

  const finalizedGroups = new Map<string, ConversationWorkActivityGroup>();
  for (const [turnId, group] of groupsByTurn) {
    finalizedGroups.set(turnId, finalizeGroup(group, snapshot, latestWorkTurnId));
  }

  const entries: ConversationTimelineEntry[] = [];
  const emittedGroupTurnIds = new Set<string>();

  for (const item of snapshot.items) {
    if (actionAssistantMessageIds.has(item.id)) {
      continue;
    }

    const turnId = effectiveTurnIds.get(item.id) ?? null;
    const group = turnId ? finalizedGroups.get(turnId) : null;

    if (group && isGroupedWorkItem(item, turnId, finalAssistantMessageIds)) {
      if (!emittedGroupTurnIds.has(turnId!)) {
        entries.push({ kind: "workActivity", group });
        emittedGroupTurnIds.add(turnId!);
      }
      continue;
    }

    if (group && finalAssistantMessageIds.has(item.id) && !emittedGroupTurnIds.has(turnId!)) {
      entries.push({ kind: "workActivity", group });
      emittedGroupTurnIds.add(turnId!);
    }

    entries.push({ kind: "item", item });
  }

  for (const [turnId, group] of finalizedGroups) {
    if (!emittedGroupTurnIds.has(turnId)) {
      entries.push({ kind: "workActivity", group });
    }
  }

  return entries;
}

export function collectStructuredActionAssistantMessageIds(
  snapshot: ThreadConversationSnapshot,
) {
  const effectiveTurnIds = inferEffectiveTurnIds(snapshot);
  const actionTurnIds = collectAssistantSuppressedTurnIds(snapshot);
  return collectAssistantMessageIdsForTurns(
    snapshot.items,
    effectiveTurnIds,
    actionTurnIds,
  );
}

function collectActionTurnIds(snapshot: ThreadConversationSnapshot) {
  const turnIds = new Set<string>();

  if (shouldRenderProposedPlan(snapshot.proposedPlan)) {
    turnIds.add(snapshot.proposedPlan!.turnId);
  }

  for (const interaction of snapshot.pendingInteractions) {
    if (interaction.turnId) {
      turnIds.add(interaction.turnId);
    }
  }

  return turnIds;
}

function collectAssistantSuppressedTurnIds(snapshot: ThreadConversationSnapshot) {
  const turnIds = new Set<string>();

  if (shouldRenderProposedPlan(snapshot.proposedPlan)) {
    turnIds.add(snapshot.proposedPlan!.turnId);
  }

  for (const interaction of snapshot.pendingInteractions) {
    if (interaction.kind === "userInput" && interaction.turnId) {
      turnIds.add(interaction.turnId);
    }
  }

  return turnIds;
}

function collectFinalAssistantMessageIds(
  snapshot: ThreadConversationSnapshot,
  items: ConversationItem[],
  effectiveTurnIds: Map<string, string>,
  actionTurnIds: Set<string>,
) {
  const lastAssistantMessageIdByTurn = new Map<string, string>();
  const suppressedFinalTurnIds = new Set(actionTurnIds);
  if (snapshot.activeTurnId && snapshot.status === "running") {
    suppressedFinalTurnIds.add(snapshot.activeTurnId);
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const turnId = effectiveTurnIds.get(item.id);
    if (
      !turnId ||
      suppressedFinalTurnIds.has(turnId) ||
      lastAssistantMessageIdByTurn.has(turnId)
    ) {
      continue;
    }
    if (item.kind === "message" && item.role === "assistant") {
      lastAssistantMessageIdByTurn.set(turnId, item.id);
    }
  }

  const ids = new Set<string>();
  for (const itemId of lastAssistantMessageIdByTurn.values()) {
    ids.add(itemId);
  }

  return ids;
}

function collectAssistantMessageIdsForTurns(
  items: ConversationItem[],
  effectiveTurnIds: Map<string, string>,
  targetTurnIds: Set<string>,
) {
  const lastAssistantMessageIdByTurn = new Map<string, string>();

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const turnId = effectiveTurnIds.get(item.id);
    if (
      !turnId ||
      !targetTurnIds.has(turnId) ||
      lastAssistantMessageIdByTurn.has(turnId)
    ) {
      continue;
    }
    if (item.kind === "message" && item.role === "assistant") {
      lastAssistantMessageIdByTurn.set(turnId, item.id);
    }
  }

  return new Set(lastAssistantMessageIdByTurn.values());
}

function isGroupedWorkItem(
  item: ConversationItem,
  turnId: string | null,
  finalAssistantMessageIds: Set<string>,
) {
  if (!turnId) {
    return false;
  }
  if (item.kind === "message" && item.role === "user") {
    return false;
  }
  return !finalAssistantMessageIds.has(item.id);
}

function inferEffectiveTurnIds(snapshot: ThreadConversationSnapshot) {
  const turnIds = new Map<string, string>();
  const previousTurnIds: Array<string | null> = [];
  const nextTurnIds: Array<string | null> = new Array(snapshot.items.length).fill(null);
  let previousTurnId: string | null = null;

  snapshot.items.forEach((item, index) => {
    if (item.kind === "message" && item.role === "user") {
      previousTurnId = item.turnId ?? null;
      if (item.turnId) {
        turnIds.set(item.id, item.turnId);
      }
    } else if (item.turnId) {
      previousTurnId = item.turnId;
      turnIds.set(item.id, item.turnId);
    }
    previousTurnIds[index] = previousTurnId;
  });

  let nextTurnId: string | null = null;
  for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
    const item = snapshot.items[index];
    if (item.kind === "message" && item.role === "user") {
      nextTurnIds[index] = item.turnId ?? nextTurnId;
      nextTurnId = null;
      continue;
    }
    if (item.turnId) {
      nextTurnId = item.turnId;
    }
    nextTurnIds[index] = nextTurnId;
  }

  const activeTurnAnchorIndex = findActiveTurnAnchorIndex(snapshot);

  snapshot.items.forEach((item, index) => {
    if (
      turnIds.has(item.id) ||
      item.kind === "system" ||
      (item.kind === "message" && item.role === "user")
    ) {
      return;
    }

    const isBeforeActiveTurn =
      activeTurnAnchorIndex !== null && index <= activeTurnAnchorIndex;
    const inferredTurnId =
      (isBeforeActiveTurn ? null : nextTurnIds[index]) ??
      inferActiveTurnId(snapshot, index, activeTurnAnchorIndex) ??
      previousTurnIds[index] ??
      (isBeforeActiveTurn ? null : snapshot.activeTurnId) ??
      (isBeforeActiveTurn ? null : snapshot.taskPlan?.turnId) ??
      null;

    if (inferredTurnId) {
      turnIds.set(item.id, inferredTurnId);
    }
  });

  return turnIds;
}

function findActiveTurnAnchorIndex(snapshot: ThreadConversationSnapshot) {
  if (!snapshot.activeTurnId) {
    return null;
  }

  for (let index = 0; index < snapshot.items.length; index += 1) {
    if (snapshot.items[index]?.turnId === snapshot.activeTurnId) {
      for (let userIndex = index; userIndex >= 0; userIndex -= 1) {
        const item = snapshot.items[userIndex];
        if (item?.kind === "message" && item.role === "user") {
          return userIndex;
        }
      }
      return index;
    }
  }

  for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
    const item = snapshot.items[index];
    if (
      item?.kind === "message" &&
      item.role === "user" &&
      !item.turnId
    ) {
      return index;
    }
  }

  return null;
}

function inferActiveTurnId(
  snapshot: ThreadConversationSnapshot,
  index: number,
  activeTurnAnchorIndex: number | null,
) {
  if (!snapshot.activeTurnId) {
    return null;
  }

  if (activeTurnAnchorIndex === null) {
    return snapshot.activeTurnId;
  }

  return index > activeTurnAnchorIndex ? snapshot.activeTurnId : null;
}

function findLatestWorkTurnId(
  snapshot: ThreadConversationSnapshot,
  effectiveTurnIds: Map<string, string>,
) {
  if (snapshot.activeTurnId) {
    return snapshot.activeTurnId;
  }

  for (let index = snapshot.pendingInteractions.length - 1; index >= 0; index -= 1) {
    const turnId = snapshot.pendingInteractions[index]?.turnId;
    if (turnId) {
      return turnId;
    }
  }

  if (shouldRenderProposedPlan(snapshot.proposedPlan)) {
    return snapshot.proposedPlan!.turnId;
  }

  if (snapshot.taskPlan) {
    return snapshot.taskPlan.turnId;
  }

  for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
    const item = snapshot.items[index];
    if (
      !shouldRenderConversationItem(item) ||
      (item.kind === "message" && item.role === "user")
    ) {
      continue;
    }

    const turnId = effectiveTurnIds.get(item.id);
    if (turnId) {
      return turnId;
    }
  }

  return null;
}

function getOrCreateGroup(groupsByTurn: Map<string, MutableGroup>, turnId: string) {
  let group = groupsByTurn.get(turnId);
  if (group) {
    return group;
  }

  group = {
    turnId,
    items: [],
  };
  groupsByTurn.set(turnId, group);
  return group;
}

function finalizeGroup(
  group: MutableGroup,
  snapshot: ThreadConversationSnapshot,
  latestWorkTurnId: string | null,
): ConversationWorkActivityGroup {
  const renderableItems = group.items.filter(shouldRenderConversationItem);
  const counts = {
    updateCount: renderableItems.filter((item) => item.kind === "message").length,
    reasoningCount: renderableItems.filter((item) => item.kind === "reasoning").length,
    toolCount: renderableItems.filter((item) => item.kind === "tool").length,
    systemCount: renderableItems.filter((item) => item.kind === "system").length,
  };

  const status = statusForGroup(group.turnId, snapshot, latestWorkTurnId);
  const timing = recordTiming(group.turnId, status);

  return {
    id: `work-${group.turnId}`,
    turnId: group.turnId,
    items: renderableItems,
    counts,
    status,
    startedAt: timing?.startedAt ?? null,
    finishedAt: timing?.finishedAt ?? null,
  };
}

function statusForGroup(
  turnId: string,
  snapshot: ThreadConversationSnapshot,
  latestWorkTurnId: string | null,
): WorkActivityStatus {
  if (snapshot.activeTurnId === turnId) {
    return statusFromConversationStatus(snapshot.status);
  }

  if (turnId === latestWorkTurnId && snapshot.status !== "idle") {
    return statusFromConversationStatus(snapshot.status);
  }

  return "completed";
}

function statusFromConversationStatus(status: ConversationStatus): WorkActivityStatus {
  switch (status) {
    case "running":
      return "running";
    case "waitingForExternalAction":
      return "waiting";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "completed";
  }
}
