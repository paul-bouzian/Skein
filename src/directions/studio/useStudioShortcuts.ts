import { message } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef } from "react";

import { matchesShortcut } from "../../lib/shortcuts";
import type {
  ApprovalPolicy,
  CollaborationMode,
  ConversationComposerSettings,
  ProjectManualAction,
  ReasoningEffort,
} from "../../lib/types";
import { useConversationStore } from "../../stores/conversation-store";
import { useTerminalStore } from "../../stores/terminal-store";
import {
  selectEffectiveEnvironmentId,
  selectSettings,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import {
  archiveThreadWithConfirmation,
  createThreadForSelection,
  selectAdjacentEnvironment,
  selectAdjacentThread,
} from "./studioActions";
import { setPreferredActionIdForProject } from "./projectActions";

type Props = {
  shortcutsBlocked: boolean;
  onOpenSettings: () => void;
  onRequestApproveOrSubmit: () => void;
  onRequestComposerFocus: () => void;
  onToggleProjectsSidebar: () => void;
  onToggleReviewPanel: () => void;
};

const APPROVAL_VALUES: ApprovalPolicy[] = ["askToEdit", "fullAccess"];
const DEFAULT_SPLIT_ACTIVE_THREAD = "mod+\\";
const DEFAULT_CLOSE_FOCUSED_PANE = "mod+shift+w";

export function useStudioShortcuts({
  shortcutsBlocked,
  onOpenSettings,
  onRequestApproveOrSubmit,
  onRequestComposerFocus,
  onToggleProjectsSidebar,
  onToggleReviewPanel,
}: Props) {
  const shortcutsBlockedRef = useRef(shortcutsBlocked);
  const callbacksRef = useRef({
    onOpenSettings,
    onRequestApproveOrSubmit,
    onRequestComposerFocus,
    onToggleProjectsSidebar,
    onToggleReviewPanel,
  });

  shortcutsBlockedRef.current = shortcutsBlocked;
  callbacksRef.current = {
    onOpenSettings,
    onRequestApproveOrSubmit,
    onRequestComposerFocus,
    onToggleProjectsSidebar,
    onToggleReviewPanel,
  };

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || shortcutsBlockedRef.current) {
        return;
      }

      const {
        capabilities,
        composer,
        effectiveEnvironmentId,
        manualActions,
        selectedEnvironmentId,
        selectedProjectId,
        selectedThreadId,
        shortcuts,
        snapshot,
      } = readShortcutState();
      if (!shortcuts) {
        return;
      }

      const standardShortcutBlocked = shouldIgnoreStandardShortcut(event);
      const composerShortcutAllowed =
        !standardShortcutBlocked || isComposerTarget(event.target);
      const {
        onOpenSettings,
        onRequestApproveOrSubmit,
        onRequestComposerFocus,
        onToggleProjectsSidebar,
        onToggleReviewPanel,
      } = callbacksRef.current;
      const { interruptThread, updateComposer } = useConversationStore.getState();
      const { toggleVisible } = useTerminalStore.getState();

      if (matchesShortcut(event, shortcuts.openSettings)) {
        event.preventDefault();
        onOpenSettings();
        return;
      }

      if (
        matchesShortcut(event, shortcuts.approveOrSubmit) &&
        (snapshot?.proposedPlan?.isAwaitingDecision ||
          snapshot?.pendingInteractions[0]?.kind === "userInput")
      ) {
        event.preventDefault();
        onRequestApproveOrSubmit();
        return;
      }

      if (
        matchesShortcut(event, shortcuts.interruptThread) &&
        selectedThreadId &&
        snapshot?.status === "running" &&
        !isEditableTarget(event.target) &&
        !isTerminalTarget(event.target)
      ) {
        event.preventDefault();
        void interruptThread(selectedThreadId).catch(reportShortcutError);
        return;
      }

      if (matchesShortcut(event, shortcuts.focusComposer)) {
        event.preventDefault();
        onRequestComposerFocus();
        return;
      }

      if (composer && selectedThreadId && composerShortcutAllowed) {
        if (matchesShortcut(event, shortcuts.cycleCollaborationMode)) {
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

        if (matchesShortcut(event, shortcuts.cycleModel)) {
          event.preventDefault();
          const values = capabilities?.models.map((option) => option.id) ?? [composer.model];
          const next = cycleValue(values, composer.model);
          if (next) {
            updateComposer(selectedThreadId, { model: next });
          }
          return;
        }

        if (matchesShortcut(event, shortcuts.cycleReasoningEffort)) {
          event.preventDefault();
          const values = supportedEffortsForComposer(composer, capabilities?.models);
          const next = cycleValue(values, composer.reasoningEffort);
          if (next) {
            updateComposer(selectedThreadId, { reasoningEffort: next });
          }
          return;
        }

        if (matchesShortcut(event, shortcuts.cycleApprovalPolicy)) {
          event.preventDefault();
          const next = cycleValue(APPROVAL_VALUES, composer.approvalPolicy);
          if (next) {
            updateComposer(selectedThreadId, { approvalPolicy: next });
          }
          return;
        }
      }

      if (standardShortcutBlocked) {
        return;
      }

      if (matchesShortcut(event, shortcuts.toggleProjectsSidebar)) {
        event.preventDefault();
        onToggleProjectsSidebar();
        return;
      }

      if (matchesShortcut(event, shortcuts.toggleReviewPanel)) {
        event.preventDefault();
        onToggleReviewPanel();
        return;
      }

      if (matchesShortcut(event, shortcuts.toggleTerminal)) {
        if (!effectiveEnvironmentId) {
          return;
        }
        event.preventDefault();
        toggleVisible(effectiveEnvironmentId);
        return;
      }

      if (matchesShortcut(event, shortcuts.newThread)) {
        event.preventDefault();
        void createThreadForSelection().catch(reportShortcutError);
        return;
      }

      if (matchesShortcut(event, shortcuts.archiveCurrentThread) && selectedThreadId) {
        event.preventDefault();
        void archiveThreadWithConfirmation(selectedThreadId).catch(reportShortcutError);
        return;
      }

      if (matchesShortcut(event, shortcuts.nextThread)) {
        event.preventDefault();
        selectAdjacentThread("next");
        return;
      }

      if (matchesShortcut(event, shortcuts.previousThread)) {
        event.preventDefault();
        selectAdjacentThread("previous");
        return;
      }

      if (matchesShortcut(event, shortcuts.nextEnvironment)) {
        event.preventDefault();
        selectAdjacentEnvironment("next");
        return;
      }

      if (matchesShortcut(event, shortcuts.previousEnvironment)) {
        event.preventDefault();
        selectAdjacentEnvironment("previous");
        return;
      }

      if (
        matchesShortcut(
          event,
          shortcuts.splitActiveThread === undefined
            ? DEFAULT_SPLIT_ACTIVE_THREAD
            : shortcuts.splitActiveThread,
        )
      ) {
        event.preventDefault();
        const workspace = useWorkspaceStore.getState();
        if (workspace.selectedThreadId) {
          workspace.openThreadInOtherPane(workspace.selectedThreadId);
        }
        return;
      }

      if (
        matchesShortcut(
          event,
          shortcuts.closeFocusedPane === undefined
            ? DEFAULT_CLOSE_FOCUSED_PANE
            : shortcuts.closeFocusedPane,
        )
      ) {
        event.preventDefault();
        const workspace = useWorkspaceStore.getState();
        const focused = workspace.layout.focusedSlot;
        // Only close when there's more than one pane — the user should
        // archive/close the thread instead of closing the last pane.
        if (
          focused &&
          Object.values(workspace.layout.slots).filter(Boolean).length > 1
        ) {
          workspace.closePane(focused);
        }
        return;
      }

      if (selectedEnvironmentId && selectedProjectId) {
        for (const action of manualActions) {
          if (!matchesShortcut(event, action.shortcut)) {
            continue;
          }
          event.preventDefault();
          void launchProjectActionShortcut(
            selectedEnvironmentId,
            selectedProjectId,
            action,
          ).catch(reportShortcutError);
          return;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
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

function readShortcutState() {
  const workspaceState = useWorkspaceStore.getState();
  const conversationState = useConversationStore.getState();
  const selectedThreadId = workspaceState.selectedThreadId;
  const selectedEnvironmentId = workspaceState.selectedEnvironmentId;
  const effectiveEnvironmentId = selectEffectiveEnvironmentId(workspaceState);
  const selectedProjectId = workspaceState.selectedProjectId;
  const snapshot = selectedThreadId
    ? conversationState.snapshotsByThreadId[selectedThreadId] ?? null
    : null;
  const composer =
    (selectedThreadId
      ? conversationState.composerByThreadId[selectedThreadId] ?? null
      : null) ??
    snapshot?.composer ??
    null;
  const capabilities = selectedEnvironmentId
    ? conversationState.capabilitiesByEnvironmentId[selectedEnvironmentId] ?? null
    : null;
  const manualActions =
    workspaceState.snapshot?.projects.find((project) => project.id === selectedProjectId)?.settings
      .manualActions ?? [];

  return {
    capabilities,
    composer,
    effectiveEnvironmentId,
    manualActions,
    selectedEnvironmentId,
    selectedProjectId,
    selectedThreadId,
    shortcuts: selectSettings(workspaceState)?.shortcuts ?? null,
    snapshot,
  };
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

function isComposerTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(target.closest(".tx-composer"))
    : false;
}

async function launchProjectActionShortcut(
  environmentId: string,
  projectId: string,
  action: ProjectManualAction,
) {
  const tabId = await useTerminalStore.getState().openActionTab(environmentId, action);
  if (!tabId) {
    await message("Maximum 10 terminals are open in this environment.", {
      title: "Project action",
      kind: "warning",
    });
    return;
  }

  setPreferredActionIdForProject(projectId, action.id);
}

function reportShortcutError(error: unknown) {
  console.error("Shortcut action failed:", error);
}
