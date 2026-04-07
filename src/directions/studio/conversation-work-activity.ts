import type {
  ConversationItem,
  ConversationStatus,
  ConversationTaskSnapshot,
  ProposedPlanSnapshot,
  SubagentThreadSnapshot,
  ThreadConversationSnapshot,
} from "../../lib/types";

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
  taskPlan?: ConversationTaskSnapshot | null;
  subagents: SubagentThreadSnapshot[];
  counts: {
    updateCount: number;
    reasoningCount: number;
    toolCount: number;
    systemCount: number;
    subagentCount: number;
  };
  status: WorkActivityStatus;
};

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
  taskPlan: ConversationTaskSnapshot | null;
  subagents: SubagentThreadSnapshot[];
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
  const effectiveTurnIds = inferEffectiveTurnIds(snapshot);
  const finalAssistantMessageIds = collectFinalAssistantMessageIds(
    snapshot,
    snapshot.items,
    effectiveTurnIds,
    actionTurnIds,
  );
  const renderableTaskPlan = hasRenderableTaskPlan(snapshot.taskPlan);

  for (const item of snapshot.items) {
    const turnId = effectiveTurnIds.get(item.id) ?? null;
    if (!turnId || !isGroupedWorkItem(item, turnId, finalAssistantMessageIds)) {
      continue;
    }
    getOrCreateGroup(groupsByTurn, turnId).items.push(item);
  }

  if (renderableTaskPlan && snapshot.taskPlan) {
    getOrCreateGroup(groupsByTurn, snapshot.taskPlan.turnId).taskPlan = snapshot.taskPlan;
  }

  const subagentTurnId = snapshot.activeTurnId ?? snapshot.taskPlan?.turnId ?? null;
  if (subagentTurnId && snapshot.subagents.length > 0) {
    getOrCreateGroup(groupsByTurn, subagentTurnId).subagents = snapshot.subagents;
  }

  const finalizedGroups = new Map<string, ConversationWorkActivityGroup>();
  for (const [turnId, group] of groupsByTurn) {
    finalizedGroups.set(turnId, finalizeGroup(group, snapshot));
  }

  const entries: ConversationTimelineEntry[] = [];
  const emittedGroupTurnIds = new Set<string>();

  for (const item of snapshot.items) {
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

function collectFinalAssistantMessageIds(
  snapshot: ThreadConversationSnapshot,
  items: ConversationItem[],
  effectiveTurnIds: Map<string, string>,
  actionTurnIds: Set<string>,
) {
  const lastAssistantMessageIdByTurn = new Map<string, string>();
  const suppressedFinalTurnIds = new Set(actionTurnIds);

  if (snapshot.activeTurnId) {
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
    if (item.turnId) {
      previousTurnId = item.turnId;
      turnIds.set(item.id, item.turnId);
    }
    previousTurnIds[index] = previousTurnId;
  });

  let nextTurnId: string | null = null;
  for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
    const item = snapshot.items[index];
    if (item.turnId) {
      nextTurnId = item.turnId;
    }
    nextTurnIds[index] = nextTurnId;
  }

  snapshot.items.forEach((item, index) => {
    if (turnIds.has(item.id) || (item.kind === "message" && item.role === "user")) {
      return;
    }

    const inferredTurnId =
      previousTurnIds[index] ??
      nextTurnIds[index] ??
      snapshot.activeTurnId ??
      snapshot.taskPlan?.turnId ??
      null;

    if (inferredTurnId) {
      turnIds.set(item.id, inferredTurnId);
    }
  });

  return turnIds;
}

function getOrCreateGroup(groupsByTurn: Map<string, MutableGroup>, turnId: string) {
  let group = groupsByTurn.get(turnId);
  if (group) {
    return group;
  }

  group = {
    turnId,
    items: [],
    taskPlan: null,
    subagents: [],
  };
  groupsByTurn.set(turnId, group);
  return group;
}

function finalizeGroup(
  group: MutableGroup,
  snapshot: ThreadConversationSnapshot,
): ConversationWorkActivityGroup {
  const counts = {
    updateCount: group.items.filter((item) => item.kind === "message").length,
    reasoningCount: group.items.filter((item) => item.kind === "reasoning").length,
    toolCount: group.items.filter((item) => item.kind === "tool").length,
    systemCount: group.items.filter((item) => item.kind === "system").length,
    subagentCount: group.subagents.length,
  };

  return {
    id: `work-${group.turnId}`,
    turnId: group.turnId,
    items: group.items,
    taskPlan: group.taskPlan,
    subagents: group.subagents,
    counts,
    status: statusForGroup(group.turnId, group, snapshot),
  };
}

function statusForGroup(
  turnId: string,
  group: MutableGroup,
  snapshot: ThreadConversationSnapshot,
): WorkActivityStatus {
  if (snapshot.activeTurnId === turnId) {
    return statusFromConversationStatus(snapshot.status);
  }

  if (group.taskPlan) {
    switch (group.taskPlan.status) {
      case "failed":
        return "failed";
      case "interrupted":
        return "interrupted";
      case "completed":
        return "completed";
      default:
        return "running";
    }
  }

  if (group.subagents.some((subagent) => subagent.status === "running")) {
    return "running";
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
