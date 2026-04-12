import type { OpenTarget, OpenTargetKind } from "../../lib/types";

export type DraftOpenTarget = {
  draftKey: string;
  id: string;
  label: string;
  kind: OpenTargetKind;
  appName: string;
  command: string;
  argsText: string;
};

export type DraftIssues = {
  global: string | null;
  byKey: Record<string, string>;
};

export type OpenInDraftState = {
  targets: DraftOpenTarget[];
  defaultDraftKey: string | null;
};

let nextDraftId = 0;
const DRAFT_ID_PREFIX = "open-target-draft-";

export function buildDraftState(targets: OpenTarget[], defaultTargetId: string) {
  const nextTargets = buildDraftTargets(targets);
  return {
    targets: nextTargets,
    defaultDraftKey: resolveDefaultDraftKey(nextTargets, defaultTargetId),
  };
}

export function validateDraftTargets(
  targets: DraftOpenTarget[],
  defaultDraftKey: string | null,
): DraftIssues {
  if (targets.length === 0) {
    return {
      global: "Add at least one Open In target.",
      byKey: {},
    };
  }

  const byKey: Record<string, string> = {};
  for (const target of targets) {
    if (!target.label.trim()) {
      byKey[target.draftKey] = "Label is required.";
      continue;
    }
    if (target.kind === "app" && !target.appName.trim()) {
      byKey[target.draftKey] = "Application name is required.";
      continue;
    }
    if (target.kind === "command" && !target.command.trim()) {
      byKey[target.draftKey] = "Command is required.";
    }
  }

  if (
    !defaultDraftKey ||
    !targets.some((target) => target.draftKey === defaultDraftKey)
  ) {
    return {
      global: "Choose a default target.",
      byKey,
    };
  }

  return {
    global: null,
    byKey,
  };
}

export function matchesPersistedTargets(
  draftTargets: DraftOpenTarget[],
  defaultDraftKey: string | null,
  targets: OpenTarget[],
  defaultTargetId: string,
) {
  const finalizedDraftTargets = finalizeDraftTargets(draftTargets);
  if (finalizedDraftTargets.length !== targets.length) {
    return false;
  }

  const defaultIndex = draftTargets.findIndex(
    (target) => target.draftKey === defaultDraftKey,
  );
  if (
    defaultIndex === -1 ||
    finalizedDraftTargets[defaultIndex]?.id !== defaultTargetId
  ) {
    return false;
  }

  return finalizedDraftTargets.every((target, index) => {
    const persisted = targets[index];
    if (!persisted) {
      return false;
    }
    return openTargetsEqual(target, persisted);
  });
}

export function persistedOpenInSettingsEqual(
  leftTargets: OpenTarget[],
  leftDefaultTargetId: string,
  rightTargets: OpenTarget[],
  rightDefaultTargetId: string,
) {
  return (
    leftDefaultTargetId === rightDefaultTargetId &&
    leftTargets.length === rightTargets.length &&
    leftTargets.every((target, index) => {
      const otherTarget = rightTargets[index];
      return otherTarget ? openTargetsEqual(target, otherTarget) : false;
    })
  );
}

export function persistDraftTargets(state: OpenInDraftState) {
  const defaultIndex = state.targets.findIndex(
    (target) => target.draftKey === state.defaultDraftKey,
  );
  if (defaultIndex === -1) {
    return null;
  }
  const persistedTargets = finalizeDraftTargets(state.targets);

  const persistedDefaultTarget = persistedTargets[defaultIndex];
  if (!persistedDefaultTarget) {
    return null;
  }

  return {
    openTargets: persistedTargets,
    defaultOpenTargetId: persistedDefaultTarget.id,
  };
}

export function toPersistedTarget(target: DraftOpenTarget): OpenTarget {
  const appName =
    target.kind === "app" ? target.appName.trim() || null : null;
  const command =
    target.kind === "command" ? target.command.trim() || null : null;

  return {
    id: target.id,
    label: target.label.trim(),
    kind: target.kind,
    appName,
    command,
    args: parseArgs(target.argsText),
  };
}

export function moveDraftTarget(
  targets: DraftOpenTarget[],
  draftKey: string,
  direction: -1 | 1,
) {
  const index = targets.findIndex((target) => target.draftKey === draftKey);
  const nextIndex = index + direction;
  if (index === -1 || nextIndex < 0 || nextIndex >= targets.length) {
    return targets;
  }

  const nextTargets = targets.slice();
  const [target] = nextTargets.splice(index, 1);
  if (!target) {
    return targets;
  }
  nextTargets.splice(nextIndex, 0, target);
  return nextTargets;
}

export function createDraftTarget(kind: OpenTargetKind): DraftOpenTarget {
  const draftKey = nextOpenTargetDraftKey();
  return {
    draftKey,
    id: draftKey,
    label: "",
    kind,
    appName: "",
    command: "",
    argsText: "",
  };
}

export function parseArgs(argsText: string) {
  return argsText
    .split("\n")
    .map((argument) => argument.trim())
    .filter(Boolean);
}

function finalizeDraftTargets(targets: DraftOpenTarget[]) {
  const seenIds = new Set<string>();
  return targets.map((target, index) => {
    const persisted = toPersistedTarget(target);
    const baseId = persistedIdForDraft(target, index);
    const uniqueId = dedupeId(baseId, seenIds);
    seenIds.add(uniqueId);
    return {
      ...persisted,
      id: uniqueId,
    };
  });
}

function persistedIdForDraft(
  target: DraftOpenTarget,
  index = 0,
) {
  const trimmedId = target.id.trim();
  if (trimmedId && !trimmedId.startsWith(DRAFT_ID_PREFIX)) {
    return trimmedId;
  }

  const labelSlug = slugify(target.label);
  if (labelSlug) {
    return labelSlug;
  }

  const kindPrefix =
    target.kind === "fileManager"
      ? "file-manager"
      : target.kind === "command"
        ? "command"
        : "app";
  return `${kindPrefix}-${index + 1}`;
}

function dedupeId(baseId: string, seenIds: Set<string>) {
  if (!seenIds.has(baseId)) {
    return baseId;
  }

  let suffix = 2;
  let nextId = `${baseId}-${suffix}`;
  while (seenIds.has(nextId)) {
    suffix += 1;
    nextId = `${baseId}-${suffix}`;
  }
  return nextId;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function openTargetsEqual(left: OpenTarget, right: OpenTarget) {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.kind === right.kind &&
    (left.appName ?? null) === (right.appName ?? null) &&
    (left.command ?? null) === (right.command ?? null) &&
    arraysEqual(left.args, right.args)
  );
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildDraftTargets(targets: OpenTarget[]) {
  return targets.map((target) => ({
    draftKey: nextOpenTargetDraftKey(),
    id: target.id,
    label: target.label,
    kind: target.kind,
    appName: target.appName ?? "",
    command: target.command ?? "",
    argsText: target.args.join("\n"),
  }));
}

function resolveDefaultDraftKey(
  targets: DraftOpenTarget[],
  defaultTargetId: string,
) {
  if (targets.length === 0) {
    return null;
  }
  const matched = targets.find((target) => target.id === defaultTargetId);
  return matched ? matched.draftKey : targets[0]?.draftKey ?? null;
}

function nextOpenTargetDraftKey() {
  nextDraftId += 1;
  return `open-target-draft-${nextDraftId}`;
}
