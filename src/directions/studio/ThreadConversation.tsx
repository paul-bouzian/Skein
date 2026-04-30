import {
  type UIEvent,
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
  ConversationItem,
  GlobalSettings,
  EnvironmentRecord,
  ProviderKind,
  ThreadRecord,
} from "../../lib/types";
import { ThreadIcon } from "../../shared/Icons";
import {
  selectConversationCapabilities,
  selectConversationComposer,
  selectConversationDraft,
  selectConversationError,
  selectConversationHydration,
  selectConversationRuntimeHydration,
  selectConversationSnapshot,
  selectPendingFirstMessage,
  useConversationStore,
  type PendingFirstMessage,
} from "../../stores/conversation-store";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { ConversationActiveTasksPanel } from "./ConversationActiveTasksPanel";
import { ConversationInteractionPanel } from "./ConversationInteractionPanel";
import { ConversationBanner, ConversationItemRow } from "./ConversationItemRow";
import { ConversationPlanCard } from "./ConversationPlanCard";
import { ConversationWorkActivityGroup } from "./ConversationWorkActivityGroup";
import { InlineComposer } from "./composer/InlineComposer";
import { claudeModelContextTokens } from "./claudeModelContext";
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
  const composerDraft = useConversationStore(selectConversationDraft(thread.id));
  const capabilities = useConversationStore(
    selectConversationCapabilities(environment.id),
  );
  const hydration = useConversationStore(selectConversationHydration(thread.id));
  const runtimeHydration = useConversationStore(
    selectConversationRuntimeHydration(thread.id),
  );
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
  const pendingFirstMessage = useConversationStore(
    selectPendingFirstMessage(thread.id),
  );
  const consumePendingFirstMessage = useConversationStore(
    (state) => state.consumePendingFirstMessage,
  );
  const enqueuePendingFirstMessage = useConversationStore(
    (state) => state.enqueuePendingFirstMessage,
  );
  const pendingFirstMessageRetryRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPending, startTransition] = useTransition();
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineFollowBottomRef = useRef(true);
  const refreshInFlightRef = useRef(false);
  const lastSubagentHydrationKeyRef = useRef<string | null>(null);
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
    pendingFirstMessageRetryRef.current = false;
    timelineFollowBottomRef.current = true;
    setIsSubmitting(false);
  }, [thread.id]);

  // Streaming updates (tool outputDelta, reasoning deltas, assistant text)
  // append to existing items without changing coarse snapshot fields like
  // items.length, so the next effect alone would never fire on live growth.
  // A MutationObserver on the timeline covers the in-place growth case:
  // whenever children/text change and the user is still sitting near the
  // bottom, we realign. The rAF throttle collapses bursts of mutations
  // into one scroll write per frame.
  useEffect(() => {
    const element = timelineRef.current;
    if (!element) return;
    if (typeof MutationObserver === "undefined") return;

    let frame: number | null = null;
    const followBottom = () => {
      frame = null;
      if (!timelineFollowBottomRef.current) return;
      element.scrollTop = element.scrollHeight;
    };

    const observer = new MutationObserver(() => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(followBottom);
    });
    observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const element = timelineRef.current;
    if (!element) return;
    if (!timelineFollowBottomRef.current) return;
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

    if (snapshot.subagents.length === 0) {
      refreshInFlightRef.current = false;
      lastSubagentHydrationKeyRef.current = null;
      return undefined;
    }

    const hasUnnamedSubagent = snapshot.subagents.some(
      (subagent) => !subagent.nickname,
    );
    const hasRunningSubagent = snapshot.subagents.some(
      (subagent) => subagent.status === "running",
    );
    const shouldPollSubagents = hasRunningSubagent || hasUnnamedSubagent;
    const hydrationKey = hasUnnamedSubagent
      ? snapshot.subagents
          .filter((subagent) => !subagent.nickname)
          .map((subagent) => subagent.threadId)
          .join("|")
      : null;

    if (
      hydrationKey &&
      hydrationKey !== lastSubagentHydrationKeyRef.current &&
      !refreshInFlightRef.current
    ) {
      lastSubagentHydrationKeyRef.current = hydrationKey;
      refreshInFlightRef.current = true;
      void refreshThread(thread.id).finally(() => {
        refreshInFlightRef.current = false;
      });
    }

    if (!shouldPollSubagents) {
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
    }, hasUnnamedSubagent ? 3_000 : 10_000);

    return () => window.clearInterval(interval);
  }, [
    refreshThread,
    snapshot?.activeTurnId,
    snapshot?.codexThreadId,
    snapshot?.subagents,
    thread.id,
  ]);

  const activePlan = snapshot?.proposedPlan ?? null;
  const activeTaskPlan = snapshot?.taskPlan ?? null;
  const shouldRenderPlanCard = shouldRenderProposedPlan(activePlan);
  const hasActiveTaskPlanContent = Boolean(
    snapshot &&
      (snapshot.status === "running" ||
        snapshot.status === "waitingForExternalAction") &&
      activeTaskPlan?.status === "running" &&
      (snapshot.activeTurnId === null ||
        activeTaskPlan.turnId === snapshot.activeTurnId) &&
      hasRenderableTaskPlan(activeTaskPlan),
  );
  const handoffAssistantProviders = useMemo(
    () => handoffAssistantProviderMap(thread),
    [thread],
  );
  const timelineEntries = useMemo(
    () => (snapshot ? buildConversationTimeline(snapshot) : []),
    [snapshot],
  );
  const interaction = snapshot?.pendingInteractions[0] ?? null;
  const fallbackComposer = useMemo(
    () => resolveFallbackComposer(thread, settings),
    [settings, thread],
  );
  const composerTarget = useMemo(
    () => ({ kind: "thread" as const, threadId: thread.id }),
    [thread.id],
  );
  const resolvedComposer = composer ?? snapshot?.composer ?? fallbackComposer;
  const approveComposer = snapshot ? resolvedComposer : null;
  const isConnectionError =
    hydration === "error" || runtimeHydration === "error";
  const transportReady = runtimeHydration === "ready";
  const showEmptyTranscript =
    timelineEntries.length === 0 &&
    !shouldRenderPlanCard &&
    !hasActiveTaskPlanContent &&
    (hydration === "ready" || snapshot === null);

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
    timelineFollowBottomRef.current = true;
    setIsSubmitting(true);
    return generation;
  }

  function finishSubmitCycle(generation: number) {
    if (submitGenerationRef.current !== generation) {
      return;
    }
    submitInFlightRef.current = false;
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
    capabilities?.models.find(
      (candidate) =>
        candidate.id === resolvedComposer.model &&
        (candidate.provider ?? "codex") === resolvedComposer.provider,
    ) ?? null;
  const selectedModelSupportsImages = modelSupportsImageInput(selectedModel);
  const contextWindowTokens = claudeModelContextTokens(
    resolvedComposer.provider,
    resolvedComposer.model,
  );
  const selectedModelUnavailable =
    Boolean(capabilities?.models.length) && selectedModel === null;
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
      selectedModelUnavailable ||
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

  // When the pane switches from a draft composer to a freshly-created
  // thread, `sendThreadDraft` stashes the user's first message in the
  // conversation store. Once this thread is ready to send we replay it
  // through the same path a normal first-message send would take, which
  // seeds the optimistic user message while background naming stays hidden.
  useEffect(() => {
    if (!transportReady) return;
    if (!pendingFirstMessage) return;
    if (submitInFlightRef.current) return;

    const payload = consumePendingFirstMessage(thread.id);
    if (!payload) return;

    const submitGeneration = beginSubmitCycle();
    resetComposerState();
    void sendMessage(
      thread.id,
      payload.text,
      payload.images,
      payload.mentionBindings,
    )
      .then((sent) => {
        if (sent) return;
        handleFailedReplay(payload);
      })
      .catch(() => {
        handleFailedReplay(payload);
      })
      .finally(() => {
        finishSubmitCycle(submitGeneration);
      });

    function handleFailedReplay(retryPayload: PendingFirstMessage) {
      // First failure: put the payload back into the pending slot so the
      // effect retries once (transient hydration / network hiccups).
      if (!pendingFirstMessageRetryRef.current) {
        pendingFirstMessageRetryRef.current = true;
        enqueuePendingFirstMessage(thread.id, retryPayload);
        return;
      }
      // Second failure: the replay path has given up. Restore text and
      // images into the thread's regular composer draft so the user still
      // sees their message and can send it manually. Mention bindings
      // carry only the send-time input shape (no positions), so they are
      // not re-injected into the draft — the user re-types any @-mention.
      updateDraft(thread.id, {
        text: retryPayload.text,
        images: retryPayload.images,
      });
    }
    // `environment` and `thread` are read snapshots of props; we only need
    // their identity (id). `beginSubmitCycle` and `finishSubmitCycle` are
    // stable on the component instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    transportReady,
    pendingFirstMessage,
    consumePendingFirstMessage,
    enqueuePendingFirstMessage,
    sendMessage,
    environment.id,
    thread.id,
  ]);

  // Track whether the user is sitting near the bottom of the timeline.
  // New items and streaming deltas auto-scroll to bottom (the effect
  // above), but only when the user hasn't manually scrolled up to read
  // older activity — otherwise the yank feels rude.
  function handleTimelineScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    timelineFollowBottomRef.current = distance <= 64;
  }

  async function handleSend(
    text: string,
    images: ConversationImageAttachment[],
    sendMentionBindings: ComposerMentionBindingInput[],
    draftMentionBindings: ComposerDraftMentionBinding[],
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
      const nextMentionBindings = [...draftMentionBindings];
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
      <div
        ref={timelineRef}
        className="tx-conversation__timeline"
        onScroll={handleTimelineScroll}
      >
        {showEmptyTranscript ? <ConversationEmpty /> : null}
        {isConnectionError ? (
          <div className="tx-conversation__reconnect" role="alert">
            {storeError ? (
              <p className="tx-conversation__reconnect-message">{storeError}</p>
            ) : null}
            <button
              type="button"
              className="tx-conversation__reconnect-button"
              onClick={() => {
                if (snapshot) {
                  void refreshThread(thread.id);
                } else {
                  void openThread(thread.id);
                }
              }}
            >
              Reconnect
            </button>
          </div>
        ) : null}
        {timelineEntries.map((entry) =>
          entry.kind === "item" ? (
            <ConversationItemRow
              key={entry.item.id}
              item={entry.item}
              provider={providerForConversationItem(
                entry.item,
                snapshot?.provider ?? thread.provider,
                handoffAssistantProviders,
              )}
            />
          ) : (
            <ConversationWorkActivityGroup
              key={entry.group.id}
              group={entry.group}
              provider={snapshot?.provider ?? thread.provider}
            />
          ),
        )}
        {shouldRenderPlanCard && activePlan ? (
          <ConversationPlanCard
            plan={activePlan}
            disabled={isRunning || isMutating}
            onApprove={() => void approvePlan(resolvedComposer)}
            onRefine={() => updateDraft(thread.id, { isRefiningPlan: true })}
          />
        ) : null}
        {snapshot?.error ? (
          <ConversationBanner
            tone="error"
            title="Runtime error"
            body={snapshot.error.message}
          />
        ) : null}
        {storeError && !isConnectionError ? (
          <ConversationBanner tone="error" title="Action failed" body={storeError} />
        ) : null}
        <ConversationInteractionPanel
          interaction={interaction}
          provider={snapshot?.provider ?? thread.provider}
          submitShortcutKey={approveOrSubmitKey}
          queueCount={snapshot?.pendingInteractions.length ?? 0}
          onRespondApproval={(response) =>
            respondToApproval(thread.id, interaction?.id ?? "", response)
          }
          onSubmitAnswers={(answers) =>
            respondToUserInput(thread.id, interaction?.id ?? "", answers)
          }
        />
      </div>
      {snapshot ? (
        <ConversationActiveTasksPanel
          key={snapshot.activeTurnId ?? "idle"}
          taskPlan={snapshot.taskPlan ?? null}
          subagents={snapshot.subagents}
          status={snapshot.status}
          activeTurnId={snapshot.activeTurnId ?? null}
        />
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
        catalogTarget={composerTarget}
        catalogRefreshKey={snapshot?.codexThreadId ?? thread.codexThreadId ?? null}
        fileSearchTarget={composerTarget}
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
        onSend={(text, images, mentionBindings, draftMentionBindings) =>
          void handleSend(text, images, mentionBindings, draftMentionBindings)
        }
        onUpdateComposer={(patch) => {
          if (patch.collaborationMode === "build") {
            updateDraft(thread.id, { isRefiningPlan: false });
          }
          updateComposer(thread.id, patch);
        }}
      />
      <div className="tx-conversation__context-meter">
        <ContextWindowMeter
          usage={snapshot?.tokenUsage}
          contextWindowTokens={contextWindowTokens}
        />
      </div>
    </div>
  );
}

function handoffAssistantProviderMap(thread: ThreadRecord) {
  const sourceProvider = thread.handoff?.sourceProvider ?? null;
  if (!sourceProvider) {
    return new Map<string, ProviderKind>();
  }
  return new Map(
    thread.handoff?.importedMessages
      .filter((message) => message.role === "assistant")
      .map((message) => [message.id, sourceProvider] as const) ?? [],
  );
}

function providerForConversationItem(
  item: ConversationItem,
  fallbackProvider: ProviderKind,
  handoffAssistantProviders: Map<string, ProviderKind>,
) {
  if (item.kind !== "message" || item.role !== "assistant") {
    return fallbackProvider;
  }
  return handoffAssistantProviders.get(item.id) ?? fallbackProvider;
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

function resolveFallbackComposer(
  thread: ThreadRecord,
  settings: GlobalSettings | null,
): ConversationComposerSettings {
  const provider =
    thread.provider ??
    thread.overrides.provider ??
    settings?.defaultProvider ??
    "codex";
  return {
    provider,
    model:
      thread.overrides.model ??
      (settings?.defaultProvider === provider ? settings.defaultModel : null) ??
      (provider === "claude" ? "claude-sonnet-4-6" : "gpt-5.4"),
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
