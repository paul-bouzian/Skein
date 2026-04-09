import { useEffect } from "react";

import { matchesShortcut } from "../../lib/shortcuts";
import type {
  ApprovalPolicy,
  CollaborationMode,
  ConversationComposerSettings,
  ReasoningEffort,
} from "../../lib/types";
import { useConversationStore } from "../../stores/conversation-store";
import { useTerminalStore } from "../../stores/terminal-store";
import { selectSettings, useWorkspaceStore } from "../../stores/workspace-store";
import {
  archiveThreadWithConfirmation,
  createManagedWorktreeForSelection,
  createThreadForSelection,
  selectAdjacentEnvironment,
  selectAdjacentThread,
} from "./studioActions";

type Props = {
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onRequestApproveOrSubmit: () => void;
  onRequestComposerFocus: () => void;
  onToggleProjectsSidebar: () => void;
  onToggleReviewPanel: () => void;
};

const APPROVAL_VALUES: ApprovalPolicy[] = ["askToEdit", "fullAccess"];

export function useStudioShortcuts({
  settingsOpen,
  onOpenSettings,
  onRequestApproveOrSubmit,
  onRequestComposerFocus,
  onToggleProjectsSidebar,
  onToggleReviewPanel,
}: Props) {
  const settings = useWorkspaceStore(selectSettings);
  const selectedThreadId = useWorkspaceStore((state) => state.selectedThreadId);
  const selectedEnvironmentId = useWorkspaceStore((state) => state.selectedEnvironmentId);
  const snapshot = useConversationStore((state) =>
    selectedThreadId ? state.snapshotsByThreadId[selectedThreadId] ?? null : null,
  );
  const composerOverride = useConversationStore((state) =>
    selectedThreadId ? state.composerByThreadId[selectedThreadId] ?? null : null,
  );
  const capabilities = useConversationStore((state) =>
    selectedEnvironmentId
      ? state.capabilitiesByEnvironmentId[selectedEnvironmentId] ?? null
      : null,
  );
  const interruptThread = useConversationStore((state) => state.interruptThread);
  const submitPlanDecision = useConversationStore((state) => state.submitPlanDecision);
  const updateComposer = useConversationStore((state) => state.updateComposer);
  const toggleTerminal = useTerminalStore((state) => state.toggleVisible);
  const shortcuts = settings?.shortcuts;

  useEffect(() => {
    if (!shortcuts || settingsOpen) {
      return undefined;
    }
    const activeShortcuts = shortcuts;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const standardShortcutBlocked = shouldIgnoreStandardShortcut(event);
      const composer = composerOverride ?? snapshot?.composer ?? null;

      if (matchesShortcut(event, activeShortcuts.openSettings)) {
        event.preventDefault();
        onOpenSettings();
        return;
      }

      if (
        matchesShortcut(event, activeShortcuts.approveOrSubmit) &&
        (snapshot?.proposedPlan?.isAwaitingDecision ||
          snapshot?.pendingInteractions[0]?.kind === "userInput")
      ) {
        event.preventDefault();
        if (snapshot?.pendingInteractions[0]?.kind === "userInput") {
          onRequestApproveOrSubmit();
          return;
        }
        if (composer && selectedThreadId) {
          void submitPlanDecision({
            threadId: selectedThreadId,
            action: "approve",
            composer: { ...composer, collaborationMode: "build" },
          }).catch(reportShortcutError);
        }
        return;
      }

      if (
        matchesShortcut(event, activeShortcuts.interruptThread) &&
        selectedThreadId &&
        snapshot?.status === "running" &&
        !isEditableTarget(event.target) &&
        !isTerminalTarget(event.target)
      ) {
        event.preventDefault();
        void interruptThread(selectedThreadId).catch(reportShortcutError);
        return;
      }

      if (matchesShortcut(event, activeShortcuts.focusComposer)) {
        event.preventDefault();
        onRequestComposerFocus();
        return;
      }

      if (standardShortcutBlocked) {
        return;
      }

      if (matchesShortcut(event, activeShortcuts.toggleProjectsSidebar)) {
        event.preventDefault();
        onToggleProjectsSidebar();
        return;
      }

      if (matchesShortcut(event, activeShortcuts.toggleReviewPanel)) {
        event.preventDefault();
        onToggleReviewPanel();
        return;
      }

      if (matchesShortcut(event, activeShortcuts.toggleTerminal)) {
        event.preventDefault();
        toggleTerminal();
        return;
      }

      if (matchesShortcut(event, activeShortcuts.newThread)) {
        event.preventDefault();
        void createThreadForSelection().catch(reportShortcutError);
        return;
      }

      if (matchesShortcut(event, activeShortcuts.newWorktree)) {
        event.preventDefault();
        void createManagedWorktreeForSelection().catch(reportShortcutError);
        return;
      }

      if (matchesShortcut(event, activeShortcuts.archiveCurrentThread) && selectedThreadId) {
        event.preventDefault();
        void archiveThreadWithConfirmation(selectedThreadId).catch(reportShortcutError);
        return;
      }

      if (matchesShortcut(event, activeShortcuts.nextThread)) {
        event.preventDefault();
        selectAdjacentThread("next");
        return;
      }

      if (matchesShortcut(event, activeShortcuts.previousThread)) {
        event.preventDefault();
        selectAdjacentThread("previous");
        return;
      }

      if (matchesShortcut(event, activeShortcuts.nextEnvironment)) {
        event.preventDefault();
        selectAdjacentEnvironment("next");
        return;
      }

      if (matchesShortcut(event, activeShortcuts.previousEnvironment)) {
        event.preventDefault();
        selectAdjacentEnvironment("previous");
        return;
      }

      if (!composer || !selectedThreadId) {
        return;
      }

      if (matchesShortcut(event, activeShortcuts.cycleCollaborationMode)) {
        event.preventDefault();
        const values = capabilities?.collaborationModes.map(
          (option) => option.id as CollaborationMode,
        ) ?? [composer.collaborationMode];
        const next = cycleValue(values, composer.collaborationMode);
        if (next) {
          updateComposer(selectedThreadId, { collaborationMode: next });
        }
        return;
      }

      if (matchesShortcut(event, activeShortcuts.cycleModel)) {
        const values = capabilities?.models.map((option) => option.id) ?? [composer.model];
        const next = cycleValue(values, composer.model);
        if (next) {
          event.preventDefault();
          updateComposer(selectedThreadId, { model: next });
        }
        return;
      }

      if (matchesShortcut(event, activeShortcuts.cycleReasoningEffort)) {
        const values = supportedEffortsForComposer(composer, capabilities?.models);
        const next = cycleValue(values, composer.reasoningEffort);
        if (next) {
          event.preventDefault();
          updateComposer(selectedThreadId, { reasoningEffort: next });
        }
        return;
      }

      if (matchesShortcut(event, activeShortcuts.cycleApprovalPolicy)) {
        const next = cycleValue(APPROVAL_VALUES, composer.approvalPolicy);
        if (next) {
          event.preventDefault();
          updateComposer(selectedThreadId, { approvalPolicy: next });
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    capabilities?.collaborationModes,
    capabilities?.models,
    composerOverride,
    interruptThread,
    onOpenSettings,
    onRequestApproveOrSubmit,
    onRequestComposerFocus,
    onToggleProjectsSidebar,
    onToggleReviewPanel,
    selectedEnvironmentId,
    selectedThreadId,
    settingsOpen,
    shortcuts,
    snapshot,
    submitPlanDecision,
    toggleTerminal,
    updateComposer,
  ]);
}

function supportedEffortsForComposer(
  composer: ConversationComposerSettings,
  models: Array<{ id: string; supportedReasoningEfforts: ReasoningEffort[] }> | undefined,
) {
  return (
    models?.find((model) => model.id === composer.model)?.supportedReasoningEfforts ?? [
      composer.reasoningEffort,
    ]
  );
}

function cycleValue<T extends string>(values: T[], current: T) {
  const uniqueValues = values.filter((value, index) => values.indexOf(value) === index);
  if (uniqueValues.length <= 1) {
    return null;
  }
  const currentIndex = uniqueValues.findIndex((value) => value === current);
  const baseIndex = currentIndex === -1 ? 0 : currentIndex;
  return uniqueValues[(baseIndex + 1) % uniqueValues.length] ?? null;
}

function shouldIgnoreStandardShortcut(event: KeyboardEvent) {
  return isEditableTarget(event.target) && !isTerminalTarget(event.target);
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
    ),
  );
}

function isTerminalTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(target.closest("[data-terminal-panel], [data-terminal-view]"))
    : false;
}

function reportShortcutError(error: unknown) {
  console.error("Shortcut action failed:", error);
}
