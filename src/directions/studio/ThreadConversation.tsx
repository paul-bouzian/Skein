import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import * as bridge from "../../lib/bridge";
import type {
  ComposerDraftMentionBinding,
  ComposerMentionBindingInput,
  ConversationComposerSettings,
  ConversationImageAttachment,
  GlobalSettings,
  EnvironmentRecord,
  ThreadRecord,
} from "../../lib/types";
import { ThreadIcon } from "../../shared/Icons";
import {
  selectConversationCapabilities,
  selectConversationComposer,
  selectConversationDraft,
  selectConversationError,
  selectConversationHydration,
  selectConversationSnapshot,
  useConversationStore,
} from "../../stores/conversation-store";
import { ConversationInteractionPanel } from "./ConversationInteractionPanel";
import { ConversationBanner, ConversationItemRow } from "./ConversationItemRow";
import { ConversationMeta } from "./ConversationMeta";
import { ConversationPlanCard } from "./ConversationPlanCard";
import { ConversationTaskCard } from "./ConversationTaskCard";
import { ConversationWorkActivityGroup } from "./ConversationWorkActivityGroup";
import { SubagentStrip } from "./SubagentStrip";
import { InlineComposer } from "./composer/InlineComposer";
import {
  buildConversationTimeline,
  hasRenderableTaskPlan,
  shouldRenderProposedPlan,
} from "./conversation-work-activity";
import { modelSupportsImageInput } from "./conversation-images";
import { selectSettings, useWorkspaceStore } from "../../stores/workspace-store";
import "./ThreadConversation.css";

type Props = {
  environment: EnvironmentRecord;
  thread: ThreadRecord;
  composerFocusKey?: number;
  approveOrSubmitKey?: number;
  onClosePane?: (() => void) | null;
};

export function ThreadConversation({
  environment,
  thread,
  composerFocusKey = 0,
  approveOrSubmitKey = 0,
  onClosePane = null,
}: Props) {
  const snapshot = useConversationStore(selectConversationSnapshot(thread.id));
  const composer = useConversationStore(selectConversationComposer(thread.id));
  const composerDraft = useConversationStore(selectConversationDraft(thread.id));
  const capabilities = useConversationStore(
    selectConversationCapabilities(environment.id),
  );
  const hydration = useConversationStore(selectConversationHydration(thread.id));
  const storeError = useConversationStore(selectConversationError(thread.id));
  const settings = useWorkspaceStore(selectSettings);
  const openThread = useConversationStore((state) => state.openThread);
  const refreshThread = useConversationStore((state) => state.refreshThread);
  const updateComposer = useConversationStore((state) => state.updateComposer);
  const updateDraft = useConversationStore((state) => state.updateDraft);
  const replaceDraftLocally = useConversationStore((state) => state.replaceDraftLocally);
  const sendMessage = useConversationStore((state) => state.sendMessage);
  const interruptThread = useConversationStore((state) => state.interruptThread);
  const respondToApproval = useConversationStore(
    (state) => state.respondToApprovalRequest,
  );
  const respondToUserInput = useConversationStore(
    (state) => state.respondToUserInputRequest,
  );
  const submitPlanDecision = useConversationStore((state) => state.submitPlanDecision);
  const [isPreparingWorktreeName, setIsPreparingWorktreeName] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPending, startTransition] = useTransition();
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const refreshInFlightRef = useRef(false);
  const submitInFlightRef = useRef(false);
  const submitGenerationRef = useRef(0);
  const lastApproveOrSubmitKeyRef = useRef(approveOrSubmitKey);
  const approveShortcutThreadIdRef = useRef(thread.id);
  const draft = composerDraft.text;
  const images = composerDraft.images;
  const mentionBindings = composerDraft.mentionBindings;
  const isRefiningPlan = composerDraft.isRefiningPlan;

  useEffect(() => {
    void openThread(thread.id);
  }, [openThread, thread.id]);

  useEffect(() => {
    submitGenerationRef.current += 1;
    submitInFlightRef.current = false;
    setIsPreparingWorktreeName(false);
    setIsSubmitting(false);
  }, [thread.id]);

  useEffect(() => {
    const element = timelineRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [
    snapshot?.items.length,
    snapshot?.status,
    snapshot?.pendingInteractions.length,
    snapshot?.proposedPlan?.status,
    snapshot?.taskPlan?.steps.length,
    snapshot?.taskPlan?.markdown,
    snapshot?.taskPlan?.explanation,
    snapshot?.taskPlan?.status,
    isPreparingWorktreeName,
  ]);

  useEffect(() => {
    if (!snapshot?.proposedPlan?.isAwaitingDecision && isRefiningPlan) {
      updateDraft(thread.id, { isRefiningPlan: false });
    }
  }, [isRefiningPlan, snapshot?.proposedPlan?.isAwaitingDecision, thread.id, updateDraft]);

  useEffect(() => {
    if (!snapshot?.activeTurnId || !snapshot.codexThreadId) {
      refreshInFlightRef.current = false;
      return undefined;
    }

    if (!snapshot.subagents.some((subagent) => subagent.status === "running")) {
      refreshInFlightRef.current = false;
      return undefined;
    }

    const interval = window.setInterval(() => {
      if (refreshInFlightRef.current) {
        return;
      }
      refreshInFlightRef.current = true;
      void refreshThread(thread.id).finally(() => {
        refreshInFlightRef.current = false;
      });
    }, 10_000);

    return () => window.clearInterval(interval);
  }, [
    refreshThread,
    snapshot?.activeTurnId,
    snapshot?.codexThreadId,
    snapshot?.subagents,
    thread.id,
  ]);

  const compactWorkActivity = settings?.collapseWorkActivity ?? true;
  const activePlan = snapshot?.proposedPlan ?? null;
  const activeTaskPlan = snapshot?.taskPlan ?? null;
  const shouldRenderPlanCard = shouldRenderProposedPlan(activePlan);
  const hasTaskPlanContent = hasRenderableTaskPlan(activeTaskPlan);
  const timelineEntries = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    return compactWorkActivity
      ? buildConversationTimeline(snapshot)
      : snapshot.items.map((item) => ({ kind: "item" as const, item }));
  }, [compactWorkActivity, snapshot]);
  const interaction = snapshot?.pendingInteractions[0] ?? null;
  const fallbackComposer = useMemo(
    () => resolveFallbackComposer(thread, settings),
    [settings, thread],
  );
  const resolvedComposer = composer ?? snapshot?.composer ?? fallbackComposer;
  const approveComposer = snapshot ? resolvedComposer : null;
  const isConnecting = hydration === "cold" || hydration === "loading";
  const isConnectionError = hydration === "error";
  const transportReady = hydration === "ready";

  let connectionState: "connecting" | "error" | "idle";
  if (isConnecting) {
    connectionState = "connecting";
  } else if (isConnectionError) {
    connectionState = "error";
  } else {
    connectionState = "idle";
  }

  useEffect(() => {
    if (!transportReady) {
      return undefined;
    }

    void bridge.touchEnvironmentRuntime(environment.id).catch(() => undefined);

    const interval = window.setInterval(() => {
      void bridge.touchEnvironmentRuntime(environment.id).catch(() => undefined);
    }, 60_000);

    return () => window.clearInterval(interval);
  }, [environment.id, transportReady]);

  if (approveShortcutThreadIdRef.current !== thread.id) {
    approveShortcutThreadIdRef.current = thread.id;
    lastApproveOrSubmitKeyRef.current = approveOrSubmitKey;
  }

  function resetComposerState() {
    startTransition(() => {
      replaceDraftLocally(thread.id, null);
    });
  }

  function beginSubmitCycle() {
    submitGenerationRef.current += 1;
    const generation = submitGenerationRef.current;
    submitInFlightRef.current = true;
    setIsSubmitting(true);
    return generation;
  }

  function finishSubmitCycle(generation: number) {
    if (submitGenerationRef.current !== generation) {
      return;
    }
    submitInFlightRef.current = false;
    setIsPreparingWorktreeName(false);
    setIsSubmitting(false);
  }

  function isCurrentSubmitCycle(generation: number) {
    return submitGenerationRef.current === generation;
  }

  const approvePlan = useEffectEvent(async (nextComposer: typeof approveComposer) => {
    if (!nextComposer || submitInFlightRef.current) return;
    const submitGeneration = beginSubmitCycle();
    try {
      const sent = await submitPlanDecision({
        threadId: thread.id,
        action: "approve",
        composer: { ...nextComposer, collaborationMode: "build" },
      });
      if (sent && isCurrentSubmitCycle(submitGeneration)) {
        resetComposerState();
      }
    } finally {
      finishSubmitCycle(submitGeneration);
    }
  });

  useEffect(() => {
    if (approveOrSubmitKey === lastApproveOrSubmitKeyRef.current) {
      return;
    }
    lastApproveOrSubmitKeyRef.current = approveOrSubmitKey;
    if (
      approveOrSubmitKey === 0 ||
      interaction != null ||
      !snapshot?.proposedPlan?.isAwaitingDecision
    ) {
      return;
    }
    void approvePlan(approveComposer);
  }, [
    approvePlan,
    approveComposer,
    approveOrSubmitKey,
    interaction,
    snapshot?.proposedPlan?.isAwaitingDecision,
  ]);

  const selectedModel =
    capabilities?.models.find((candidate) => candidate.id === resolvedComposer.model) ?? null;
  const selectedModelSupportsImages = modelSupportsImageInput(selectedModel);
  const effortOptions = selectedModel?.supportedReasoningEfforts ?? [
    resolvedComposer.reasoningEffort,
  ];
  const composerLocked =
    Boolean(interaction) ||
    Boolean(activePlan?.isAwaitingDecision && !isRefiningPlan) ||
    !transportReady;
  const isRunning = snapshot?.status === "running";
  const isMutating = isPending || isSubmitting;
  const hasDraftContent = draft.trim().length > 0;
  const hasAttachedImages = images.length > 0;
  const missingRequiredContent = isRefiningPlan
    ? !hasDraftContent
    : !hasDraftContent && !hasAttachedImages;
  const sendDisabled =
    (missingRequiredContent ||
      (hasAttachedImages && !selectedModelSupportsImages) ||
      isRunning ||
      isMutating ||
      (composerLocked && !isRefiningPlan));

  function restoreComposerState(
    nextDraft: string,
    nextImages: ConversationImageAttachment[],
    nextMentionBindings: ComposerDraftMentionBinding[],
  ) {
    startTransition(() => {
      replaceDraftLocally(thread.id, {
        text: nextDraft,
        images: nextImages,
        mentionBindings: nextMentionBindings,
        isRefiningPlan,
      });
    });
  }

  async function handleSend(
    text: string,
    images: ConversationImageAttachment[],
    sendMentionBindings: ComposerMentionBindingInput[],
  ) {
    if (sendDisabled || submitInFlightRef.current) return;
    const message = text.trim();
    const submitGeneration = beginSubmitCycle();
    try {
      if (isRefiningPlan) {
        const sent = await submitPlanDecision({
          threadId: thread.id,
          action: "refine",
          feedback: message,
          composer: { ...resolvedComposer, collaborationMode: "plan" },
          ...(images.length > 0 ? { images } : {}),
          ...(sendMentionBindings.length > 0
            ? { mentionBindings: sendMentionBindings }
            : {}),
        });
        if (sent && isCurrentSubmitCycle(submitGeneration)) {
          resetComposerState();
        }
        return;
      }
      const nextImages = [...images];
      const nextMentionBindings = [...mentionBindings];
      const shouldPrepareWorktreeName = shouldShowFirstPromptNamingNotice(
        environment,
        thread,
        message,
      );
      if (shouldPrepareWorktreeName) {
        setIsPreparingWorktreeName(true);
      }
      const sendPromise = sendMessage(
        thread.id,
        message,
        nextImages,
        sendMentionBindings,
      );
      resetComposerState();
      const sent = await sendPromise;
      if (sent) {
        return;
      }
      if (isCurrentSubmitCycle(submitGeneration)) {
        restoreComposerState(text, nextImages, nextMentionBindings);
      }
    } finally {
      finishSubmitCycle(submitGeneration);
    }
  }

  return (
    <div className="tx-conversation">
      <ConversationMeta
        environment={environment}
        thread={thread}
        snapshot={snapshot}
        connectionState={connectionState}
        onRetryConnection={
          isConnectionError ? () => void openThread(thread.id) : null
        }
        onClose={onClosePane}
      />
      <div ref={timelineRef} className="tx-conversation__timeline">
        {isConnecting ? (
          <div className="tx-loading">
            <div className="tx-loading__bar" />
          </div>
        ) : timelineEntries.length === 0 &&
        !shouldRenderPlanCard &&
        !hasTaskPlanContent &&
        transportReady ? (
          <ConversationEmpty />
        ) : null}
        {timelineEntries.map((entry) =>
          entry.kind === "item" ? (
            <ConversationItemRow key={entry.item.id} item={entry.item} />
          ) : (
            <ConversationWorkActivityGroup key={entry.group.id} group={entry.group} />
          ),
        )}
        {isPreparingWorktreeName ? <FirstPromptNamingNotice /> : null}
        {shouldRenderPlanCard && activePlan ? (
          <ConversationPlanCard
            plan={activePlan}
            disabled={isRunning || isMutating}
            onApprove={() => void approvePlan(resolvedComposer)}
            onRefine={() => updateDraft(thread.id, { isRefiningPlan: true })}
          />
        ) : null}
        {!compactWorkActivity && hasTaskPlanContent && activeTaskPlan ? (
          <ConversationTaskCard taskPlan={activeTaskPlan} />
        ) : null}
        {snapshot?.error ? (
          <ConversationBanner
            tone="error"
            title="Runtime error"
            body={snapshot.error.message}
          />
        ) : null}
        {storeError ? (
          <ConversationBanner tone="error" title="Action failed" body={storeError} />
        ) : null}
      </div>
      <ConversationInteractionPanel
        interaction={interaction}
        submitShortcutKey={approveOrSubmitKey}
        queueCount={snapshot?.pendingInteractions.length ?? 0}
        onRespondApproval={(response) =>
          respondToApproval(thread.id, interaction?.id ?? "", response)
        }
        onSubmitAnswers={(answers) =>
          respondToUserInput(thread.id, interaction?.id ?? "", answers)
        }
      />
      {!compactWorkActivity && snapshot ? (
        <SubagentStrip subagents={snapshot.subagents} />
      ) : null}
      <InlineComposer
        environmentId={environment.id}
        threadId={thread.id}
        composer={resolvedComposer}
        collaborationModes={capabilities?.collaborationModes ?? []}
        disabled={composerLocked && !isRefiningPlan}
        draft={draft}
        effortOptions={effortOptions}
        focusKey={`${thread.id}:${composerFocusKey}`}
        images={images}
        isBusy={isRunning || isPending}
        isSending={isSubmitting}
        isRefiningPlan={isRefiningPlan}
        mentionBindings={mentionBindings}
        modelOptions={capabilities?.models ?? []}
        transportEnabled={transportReady}
        onChangeImages={(nextImages) =>
          updateDraft(thread.id, (currentDraft) => ({
            ...currentDraft,
            images:
              typeof nextImages === "function"
                ? nextImages(currentDraft.images)
                : nextImages,
          }))
        }
        tokenUsage={snapshot?.tokenUsage}
        onCancelRefine={() => updateDraft(thread.id, { isRefiningPlan: false })}
        onChangeDraft={(value, bindings) =>
          updateDraft(thread.id, {
            text: value,
            ...(bindings ? { mentionBindings: bindings } : {}),
          })
        }
        onChangeMentionBindings={(bindings) =>
          updateDraft(thread.id, { mentionBindings: bindings })
        }
        onInterrupt={() => void interruptThread(thread.id)}
        onSend={(text, images, mentionBindings) =>
          void handleSend(text, images, mentionBindings)
        }
        onUpdateComposer={(patch) => {
          if (patch.collaborationMode === "build") {
            updateDraft(thread.id, { isRefiningPlan: false });
          }
          updateComposer(thread.id, patch);
        }}
      />
    </div>
  );
}

function ConversationEmpty() {
  return (
    <div className="tx-conversation__empty">
      <ThreadIcon size={20} />
      <h3>Start a conversation</h3>
      <p>Type a message below to begin</p>
    </div>
  );
}

function FirstPromptNamingNotice() {
  return (
    <div className="tx-rename-notice" role="status" aria-live="polite">
      <span className="tx-rename-notice__spinner" aria-hidden="true" />
      <span className="tx-rename-notice__label">Naming the branch and worktree</span>
      <span className="tx-rename-notice__separator" aria-hidden="true">
        ·
      </span>
      <span className="tx-rename-notice__detail">
        Preparing a readable label before Codex starts
      </span>
    </div>
  );
}

function shouldShowFirstPromptNamingNotice(
  environment: EnvironmentRecord,
  thread: ThreadRecord,
  message: string,
) {
  if (message.trim().length === 0) {
    return false;
  }
  if (environment.kind !== "managedWorktree") {
    return false;
  }
  if (!isAutoGeneratedWorktreeName(environment.name)) {
    return false;
  }
  if (environment.threads.some((candidate) => Boolean(candidate.codexThreadId))) {
    return false;
  }

  const firstThread = [...environment.threads].sort((left, right) => {
    const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
    if (createdAtOrder !== 0) {
      return createdAtOrder;
    }
    return left.id.localeCompare(right.id);
  })[0];

  return firstThread?.id === thread.id;
}

function isAutoGeneratedWorktreeName(name: string) {
  return /^[a-z]+-[a-z]+(?:-\d+)?$/.test(name.trim());
}

function resolveFallbackComposer(
  thread: ThreadRecord,
  settings: GlobalSettings | null,
): ConversationComposerSettings {
  return {
    model: thread.overrides.model ?? settings?.defaultModel ?? "gpt-5.4",
    reasoningEffort:
      thread.overrides.reasoningEffort ??
      settings?.defaultReasoningEffort ??
      "medium",
    collaborationMode:
      thread.overrides.collaborationMode ??
      settings?.defaultCollaborationMode ??
      "build",
    approvalPolicy:
      thread.overrides.approvalPolicy ??
      settings?.defaultApprovalPolicy ??
      "askToEdit",
    serviceTier: thread.overrides.serviceTierOverridden
      ? (thread.overrides.serviceTier ?? null)
      : (settings?.defaultServiceTier ?? null),
  };
}
