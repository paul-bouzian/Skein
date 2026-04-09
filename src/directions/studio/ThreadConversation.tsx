import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import type {
  ComposerMentionBindingInput,
  ConversationImageAttachment,
  EnvironmentRecord,
  ThreadRecord,
} from "../../lib/types";
import { EmptyState } from "../../shared/EmptyState";
import {
  selectConversationCapabilities,
  selectConversationComposer,
  selectConversationError,
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
import type { ComposerDraftMentionBinding } from "./composer/composer-mention-bindings";
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
};

export function ThreadConversation({
  environment,
  thread,
  composerFocusKey = 0,
  approveOrSubmitKey = 0,
}: Props) {
  const snapshot = useConversationStore(selectConversationSnapshot(thread.id));
  const composer = useConversationStore(selectConversationComposer(thread.id));
  const capabilities = useConversationStore(
    selectConversationCapabilities(environment.id),
  );
  const loading = useConversationStore((state) => state.loadingByThreadId[thread.id] ?? false);
  const storeError = useConversationStore(selectConversationError(thread.id));
  const settings = useWorkspaceStore(selectSettings);
  const openThread = useConversationStore((state) => state.openThread);
  const refreshThread = useConversationStore((state) => state.refreshThread);
  const updateComposer = useConversationStore((state) => state.updateComposer);
  const sendMessage = useConversationStore((state) => state.sendMessage);
  const interruptThread = useConversationStore((state) => state.interruptThread);
  const respondToApproval = useConversationStore(
    (state) => state.respondToApprovalRequest,
  );
  const respondToUserInput = useConversationStore(
    (state) => state.respondToUserInputRequest,
  );
  const submitPlanDecision = useConversationStore((state) => state.submitPlanDecision);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ConversationImageAttachment[]>([]);
  const [mentionBindings, setMentionBindings] = useState<ComposerDraftMentionBinding[]>([]);
  const [isRefiningPlan, setIsRefiningPlan] = useState(false);
  const [isPreparingWorktreeName, setIsPreparingWorktreeName] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPending, startTransition] = useTransition();
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const refreshInFlightRef = useRef(false);
  const submitInFlightRef = useRef(false);
  const lastApproveOrSubmitKeyRef = useRef(approveOrSubmitKey);
  const approveShortcutThreadIdRef = useRef(thread.id);

  useEffect(() => {
    void openThread(thread.id);
  }, [openThread, thread.id]);

  useEffect(() => {
    setImages([]);
  }, [thread.id]);

  useEffect(() => {
    setIsPreparingWorktreeName(false);
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
      setIsRefiningPlan(false);
    }
  }, [isRefiningPlan, snapshot?.proposedPlan?.isAwaitingDecision]);

  useEffect(() => {
    if (!snapshot?.activeTurnId || !snapshot.codexThreadId) {
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
    }, 1000);

    return () => window.clearInterval(interval);
  }, [refreshThread, snapshot?.activeTurnId, snapshot?.codexThreadId, thread.id]);

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
  const approveComposer = snapshot ? composer ?? snapshot.composer : null;

  if (approveShortcutThreadIdRef.current !== thread.id) {
    approveShortcutThreadIdRef.current = thread.id;
    lastApproveOrSubmitKeyRef.current = approveOrSubmitKey;
  }

  function resetComposerState() {
    startTransition(() => {
      setDraft("");
      setImages([]);
      setMentionBindings([]);
    });
  }

  const approvePlan = useEffectEvent(async (nextComposer: typeof approveComposer) => {
    if (!nextComposer || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setIsSubmitting(true);
    try {
      const sent = await submitPlanDecision({
        threadId: thread.id,
        action: "approve",
        composer: { ...nextComposer, collaborationMode: "build" },
      });
      if (sent) {
        setIsRefiningPlan(false);
        resetComposerState();
      }
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
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

  if (!snapshot && loading) {
    return <ConversationLoading />;
  }

  if (!snapshot) {
    return (
      <div className="tx-conversation">
        <EmptyState
          heading="Conversation unavailable"
          body={storeError ?? "Loom could not open this thread yet."}
        />
      </div>
    );
  }

  const resolvedComposer = composer ?? snapshot.composer;
  const selectedModel =
    capabilities?.models.find((candidate) => candidate.id === resolvedComposer.model) ?? null;
  const selectedModelSupportsImages = modelSupportsImageInput(selectedModel);
  const effortOptions = selectedModel?.supportedReasoningEfforts ?? [
    resolvedComposer.reasoningEffort,
  ];
  const composerLocked =
    Boolean(interaction) || Boolean(activePlan?.isAwaitingDecision && !isRefiningPlan);
  const isRunning = snapshot.status === "running";
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
      setDraft(nextDraft);
      setImages(nextImages);
      setMentionBindings(nextMentionBindings);
    });
  }

  async function handleSend(
    text: string,
    images: ConversationImageAttachment[],
    sendMentionBindings: ComposerMentionBindingInput[],
  ) {
    if (sendDisabled || submitInFlightRef.current) return;
    const message = text.trim();
    submitInFlightRef.current = true;
    setIsSubmitting(true);
    try {
      if (isRefiningPlan) {
        const sent = await submitPlanDecision({
          threadId: thread.id,
          action: "refine",
          feedback: message,
          composer: { ...resolvedComposer, collaborationMode: "plan" },
          ...(images.length > 0 ? { images } : {}),
          ...(mentionBindings.length > 0 ? { mentionBindings } : {}),
        });
        if (sent) {
          resetComposerState();
          setIsRefiningPlan(false);
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
      restoreComposerState(text, nextImages, nextMentionBindings);
    } finally {
      setIsPreparingWorktreeName(false);
      submitInFlightRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <div className="tx-conversation">
      <ConversationMeta
        environment={environment}
        snapshot={snapshot}
        thread={thread}
      />
      <div ref={timelineRef} className="tx-conversation__timeline">
        {timelineEntries.length === 0 && !shouldRenderPlanCard && !hasTaskPlanContent ? (
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
            onRefine={() => setIsRefiningPlan(true)}
          />
        ) : null}
        {!compactWorkActivity && hasTaskPlanContent && activeTaskPlan ? (
          <ConversationTaskCard taskPlan={activeTaskPlan} />
        ) : null}
        {snapshot.error ? (
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
        queueCount={snapshot.pendingInteractions.length}
        onRespondApproval={(response) =>
          respondToApproval(thread.id, interaction?.id ?? "", response)
        }
        onSubmitAnswers={(answers) =>
          respondToUserInput(thread.id, interaction?.id ?? "", answers)
        }
      />
      {!compactWorkActivity ? <SubagentStrip subagents={snapshot.subagents} /> : null}
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
        onChangeImages={setImages}
        tokenUsage={snapshot.tokenUsage}
        onCancelRefine={() => {
          resetComposerState();
          setIsRefiningPlan(false);
        }}
        onChangeDraft={setDraft}
        onChangeMentionBindings={setMentionBindings}
        onInterrupt={() => void interruptThread(thread.id)}
        onSend={(text, images, mentionBindings) =>
          void handleSend(text, images, mentionBindings)
        }
        onUpdateComposer={(patch) => {
          if (patch.collaborationMode === "build") {
            setIsRefiningPlan(false);
          }
          updateComposer(thread.id, patch);
        }}
      />
    </div>
  );
}

function ConversationLoading() {
  return (
    <div className="tx-conversation tx-conversation--centered">
      <div className="tx-loading">
        <div className="tx-loading__bar" />
        <p>Connecting to Codex…</p>
      </div>
    </div>
  );
}

function ConversationEmpty() {
  return (
    <div className="tx-conversation__empty">
      <h3>Ready for the first turn</h3>
      <p>Codex is connected. Use Build or Plan mode to start the next turn.</p>
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
