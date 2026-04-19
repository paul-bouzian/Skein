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
    description: "Open the Settings view.",
  },
  {
    action: "focusComposer",
    group: "General",
    label: "Focus composer",
    description: "Focus the active thread composer.",
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
    description: "Archive the active thread after confirmation.",
  },
  {
    action: "nextThread",
    group: "Navigation",
    label: "Next thread",
    description: "Jump to the next active thread.",
  },
  {
    action: "previousThread",
    group: "Navigation",
    label: "Previous thread",
    description: "Jump to the previous active thread.",
  },
  {
    action: "nextEnvironment",
    group: "Navigation",
    label: "Next environment",
    description: "Jump to the next environment.",
  },
  {
    action: "previousEnvironment",
    group: "Navigation",
    label: "Previous environment",
    description: "Jump to the previous environment.",
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
    description: "Close the currently focused split pane.",
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
    description: "Cycle the selected model.",
  },
  {
    action: "cycleReasoningEffort",
    group: "Composer",
    label: "Cycle reasoning",
    description: "Cycle the reasoning effort.",
  },
  {
    action: "cycleApprovalPolicy",
    group: "Composer",
    label: "Cycle approval policy",
    description: "Cycle the approval policy.",
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
    description: "Approve a plan or submit pending input.",
  },
];
