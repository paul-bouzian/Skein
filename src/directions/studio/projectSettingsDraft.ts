import { shortcutSignature } from "../../lib/shortcuts";
import type { ProjectManualAction, ProjectRecord, ShortcutSettings } from "../../lib/types";
import { SHORTCUT_DEFINITIONS } from "./shortcutDefinitions";
import {
  buildProjectActionDraft,
  serializeProjectActionDrafts,
  type ProjectActionDraft,
} from "./projectActions";

export type ProjectDraft = {
  setup: string;
  teardown: string;
  actions: ProjectActionDraft[];
  savedSetup: string;
  savedTeardown: string;
  savedActions: ProjectActionDraft[];
};

export type ProjectActionDraftIssues = {
  label?: string;
  script?: string;
  shortcut?: string;
};

export type ProjectDraftIssues = {
  global: string | null;
  actionsById: Record<string, ProjectActionDraftIssues>;
};

export function syncProjectDrafts(
  projects: ProjectRecord[],
  current: Record<string, ProjectDraft>,
) {
  const next: Record<string, ProjectDraft> = {};

  for (const project of projects) {
    const savedSetup = project.settings.worktreeSetupScript ?? "";
    const savedTeardown = project.settings.worktreeTeardownScript ?? "";
    const savedActions = (project.settings.manualActions ?? []).map(buildProjectActionDraft);
    const existing = current[project.id];
    if (!existing) {
      next[project.id] = buildProjectDraft(savedSetup, savedTeardown, savedActions);
      continue;
    }

    next[project.id] = projectDraftDirty(existing)
      ? existing
      : buildProjectDraft(savedSetup, savedTeardown, savedActions);
  }

  return next;
}

export function buildProjectDraft(
  setup: string | null | undefined,
  teardown: string | null | undefined,
  actions: ProjectActionDraft[] | ProjectManualAction[],
): ProjectDraft {
  const savedActions = actions.map((action) =>
    buildProjectActionDraft({
      id: action.id,
      label: action.label,
      icon: action.icon,
      script: action.script,
      shortcut: action.shortcut ?? null,
    }),
  );

  return {
    setup: setup ?? "",
    teardown: teardown ?? "",
    actions: savedActions.map(cloneActionDraft),
    savedSetup: setup ?? "",
    savedTeardown: teardown ?? "",
    savedActions,
  };
}

export function validateProjectDraft(
  draft: ProjectDraft,
  shortcutSettings: ShortcutSettings,
): ProjectDraftIssues {
  const actionsById: Record<string, ProjectActionDraftIssues> = {};
  const seenActionIds = new Set<string>();
  const seenShortcuts = new Map<string, { actionId: string; label: string }>();
  const reservedShortcuts = new Map<string, string>();

  for (const definition of SHORTCUT_DEFINITIONS) {
    const value = shortcutSettings[definition.action] ?? null;
    const signature = shortcutSignature(value);
    if (signature) {
      reservedShortcuts.set(signature, definition.label);
    }
  }

  let hasIssues = false;

  for (const action of draft.actions) {
    const issue: ProjectActionDraftIssues = {};
    const actionId = action.id.trim();
    const label = action.label.trim();
    const script = action.script.trim();

    if (!actionId) {
      issue.label = "Action id is missing. Remove and recreate this action.";
    } else if (seenActionIds.has(actionId)) {
      issue.label = "This action was duplicated internally. Remove and recreate it.";
    } else {
      seenActionIds.add(actionId);
    }

    if (!label) {
      issue.label = issue.label ?? "Label is required.";
    }
    if (!script) {
      issue.script = "Script is required.";
    }

    const shortcut = action.shortcut.trim();
    if (shortcut.length > 0) {
      const signature = shortcutSignature(shortcut);
      if (!signature) {
        issue.shortcut = "Shortcut is invalid.";
      } else if (reservedShortcuts.has(signature)) {
        issue.shortcut = `${reservedShortcuts.get(signature)} already uses this shortcut.`;
      } else {
        const previous = seenShortcuts.get(signature);
        if (previous) {
          issue.shortcut = `This shortcut is already used by ${previous.label || "another action"}.`;
          actionsById[previous.actionId] = {
            ...actionsById[previous.actionId],
            shortcut: `This shortcut is already used by ${label || "another action"}.`,
          };
        } else {
          seenShortcuts.set(signature, { actionId: action.id, label: label || "another action" });
        }
      }
    }

    if (issue.label || issue.script || issue.shortcut) {
      hasIssues = true;
      actionsById[action.id] = {
        ...actionsById[action.id],
        ...issue,
      };
    }
  }

  return {
    global: hasIssues ? "Fix the highlighted project actions before saving." : null,
    actionsById,
  };
}

export function projectDraftDirty(draft: ProjectDraft) {
  return (
    draft.setup !== draft.savedSetup ||
    draft.teardown !== draft.savedTeardown ||
    serializeProjectActionDrafts(draft.actions) !== serializeProjectActionDrafts(draft.savedActions)
  );
}

export function cloneActionDraft(action: ProjectActionDraft): ProjectActionDraft {
  return { ...action };
}

export function normalizeScriptDraft(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
