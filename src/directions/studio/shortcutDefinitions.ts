import type { ShortcutSettings } from "../../lib/types";

export type ShortcutAction = keyof ShortcutSettings;

export type ShortcutDefinition = {
  action: ShortcutAction;
  label: string;
  description: string;
  group: "General" | "Navigation" | "Composer";
};

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    action: "openSettings",
    group: "General",
    label: "Open settings",
    description: "Open the Settings dialog.",
  },
  {
    action: "focusComposer",
    group: "General",
    label: "Focus composer",
    description: "Move focus to the active thread composer.",
  },
  {
    action: "toggleProjectsSidebar",
    group: "General",
    label: "Toggle Projects sidebar",
    description: "Show or hide the Projects sidebar.",
  },
  {
    action: "toggleReviewPanel",
    group: "General",
    label: "Toggle Review panel",
    description: "Show or hide the Review inspector.",
  },
  {
    action: "toggleTerminal",
    group: "General",
    label: "Toggle terminal",
    description: "Show or hide the terminal drawer.",
  },
  {
    action: "newThread",
    group: "Navigation",
    label: "New thread",
    description: "Create a new thread in the selected environment.",
  },
  {
    action: "archiveCurrentThread",
    group: "Navigation",
    label: "Archive current thread",
    description: "Archive the selected thread after confirmation.",
  },
  {
    action: "nextThread",
    group: "Navigation",
    label: "Next thread",
    description: "Move to the next active thread in the selected environment.",
  },
  {
    action: "previousThread",
    group: "Navigation",
    label: "Previous thread",
    description: "Move to the previous active thread in the selected environment.",
  },
  {
    action: "newWorktree",
    group: "Navigation",
    label: "New worktree",
    description: "Create a managed worktree for the current project.",
  },
  {
    action: "nextEnvironment",
    group: "Navigation",
    label: "Next environment",
    description: "Move to the next environment in sidebar order.",
  },
  {
    action: "previousEnvironment",
    group: "Navigation",
    label: "Previous environment",
    description: "Move to the previous environment in sidebar order.",
  },
  {
    action: "splitActiveThread",
    group: "Navigation",
    label: "Split active thread",
    description: "Duplicate the focused thread into the other pane.",
  },
  {
    action: "closeFocusedPane",
    group: "Navigation",
    label: "Close focused pane",
    description: "Close the currently focused pane in the split view.",
  },
  {
    action: "cycleCollaborationMode",
    group: "Composer",
    label: "Cycle Build/Plan mode",
    description: "Cycle the collaboration mode for the active thread.",
  },
  {
    action: "cycleModel",
    group: "Composer",
    label: "Cycle model",
    description: "Cycle the selected model for the active thread.",
  },
  {
    action: "cycleReasoningEffort",
    group: "Composer",
    label: "Cycle reasoning",
    description: "Cycle the selected reasoning effort.",
  },
  {
    action: "cycleApprovalPolicy",
    group: "Composer",
    label: "Cycle approval policy",
    description: "Cycle the selected approval policy.",
  },
  {
    action: "interruptThread",
    group: "Composer",
    label: "Interrupt active turn",
    description: "Stop the active Codex turn.",
  },
  {
    action: "approveOrSubmit",
    group: "Composer",
    label: "Approve plan / submit input",
    description: "Approve a proposed plan or submit pending user input.",
  },
];
