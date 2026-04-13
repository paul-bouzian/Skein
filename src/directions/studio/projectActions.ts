import type { ProjectActionIcon, ProjectManualAction } from "../../lib/types";

export type ProjectActionDraft = {
  id: string;
  label: string;
  icon: ProjectActionIcon;
  script: string;
  shortcut: string;
};

export const PROJECT_ACTION_ICON_OPTIONS: Array<{
  id: ProjectActionIcon;
  label: string;
}> = [
  { id: "play", label: "Run" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Configure" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
];

export const PROJECT_ACTION_LABEL_SUGGESTIONS = [
  "Dev",
  "Test",
  "Lint",
  "Build",
  "Debug",
  "Stop",
] as const;

const PREFERRED_ACTION_STORAGE_KEY = "skein-preferred-project-actions";

export function createEmptyProjectActionDraft(): ProjectActionDraft {
  return {
    id: crypto.randomUUID(),
    label: "",
    icon: "play",
    script: "",
    shortcut: "",
  };
}

export function buildProjectActionDraft(
  action: ProjectManualAction,
): ProjectActionDraft {
  return {
    id: action.id,
    label: action.label,
    icon: action.icon,
    script: action.script,
    shortcut: action.shortcut ?? "",
  };
}

export function normalizeProjectActionDraft(
  action: ProjectActionDraft,
): ProjectManualAction {
  const shortcut = action.shortcut.trim();
  return {
    id: action.id.trim(),
    label: action.label.trim(),
    icon: action.icon,
    script: action.script.trim(),
    shortcut: shortcut.length > 0 ? shortcut : null,
  };
}

export function normalizeProjectActionDrafts(
  actions: ProjectActionDraft[],
): ProjectManualAction[] {
  return actions.map(normalizeProjectActionDraft);
}

export function serializeProjectActionDrafts(actions: ProjectActionDraft[]): string {
  return JSON.stringify(actions);
}

export function preferredActionIdForProject(
  projectId: string,
  actions: ProjectManualAction[],
): string | null {
  const preferredId = readPreferredActionMap()[projectId];
  if (preferredId && actions.some((action) => action.id === preferredId)) {
    return preferredId;
  }
  return actions[0]?.id ?? null;
}

export function setPreferredActionIdForProject(
  projectId: string,
  actionId: string,
) {
  try {
    const current = readPreferredActionMap();
    if (current[projectId] === actionId) {
      return;
    }
    localStorage.setItem(
      PREFERRED_ACTION_STORAGE_KEY,
      JSON.stringify({
        ...current,
        [projectId]: actionId,
      }),
    );
  } catch {
    /* ignore */
  }
}

function readPreferredActionMap(): Record<string, string> {
  try {
    const rawValue = localStorage.getItem(PREFERRED_ACTION_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}
