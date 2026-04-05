import { useEffect, useRef, useState, useTransition } from "react";

import type {
  ComposerMentionBindingInput,
  ConversationItem,
  EnvironmentRecord,
  ThreadRecord,
} from "../../lib/types";
import { EmptyState } from "../../shared/EmptyState";
import { ChevronRightIcon } from "../../shared/Icons";
import {
  selectConversationCapabilities,
  selectConversationComposer,
  selectConversationError,
  selectConversationSnapshot,
  useConversationStore,
} from "../../stores/conversation-store";
import { ConversationInteractionPanel } from "./ConversationInteractionPanel";
import { ConversationMarkdown } from "./ConversationMarkdown";
import { ConversationMeta } from "./ConversationMeta";
import { ConversationPlanCard } from "./ConversationPlanCard";
import { SubagentStrip } from "./SubagentStrip";
import { InlineComposer } from "./composer/InlineComposer";
import type { ComposerDraftMentionBinding } from "./composer/composer-mention-bindings";
import "./ThreadConversation.css";

type Props = {
  environment: EnvironmentRecord;
  thread: ThreadRecord;
};

export function ThreadConversation({ environment, thread }: Props) {
  const snapshot = useConversationStore(selectConversationSnapshot(thread.id));
  const composer = useConversationStore(selectConversationComposer(thread.id));
  const capabilities = useConversationStore(
    selectConversationCapabilities(environment.id),
  );
  const loading = useConversationStore((state) => state.loadingByThreadId[thread.id] ?? false);
  const storeError = useConversationStore(selectConversationError(thread.id));
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
  const [mentionBindings, setMentionBindings] = useState<ComposerDraftMentionBinding[]>([]);
  const [isRefiningPlan, setIsRefiningPlan] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPending, startTransition] = useTransition();
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const refreshInFlightRef = useRef(false);
  const submitInFlightRef = useRef(false);

  useEffect(() => {
    void openThread(thread.id);
  }, [openThread, thread.id]);

  useEffect(() => {
    const element = timelineRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [
    snapshot?.items.length,
    snapshot?.status,
    snapshot?.pendingInteractions.length,
    snapshot?.proposedPlan?.status,
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

  if (!snapshot && loading) {
    return <ConversationLoading />;
  }

  if (!snapshot) {
    return (
      <div className="tx-conversation">
        <EmptyState
          heading="Conversation unavailable"
          body={storeError ?? "ThreadEx could not open this thread yet."}
        />
      </div>
    );
  }

  const resolvedComposer = composer ?? snapshot.composer;
  const selectedModel =
    capabilities?.models.find((candidate) => candidate.id === resolvedComposer.model) ?? null;
  const effortOptions = selectedModel?.supportedReasoningEfforts ?? [
    resolvedComposer.reasoningEffort,
  ];
  const activePlan = snapshot.proposedPlan;
  const interaction = snapshot.pendingInteractions[0] ?? null;
  const shouldRenderPlanCard = Boolean(
    activePlan && (activePlan.isAwaitingDecision || activePlan.status === "streaming"),
  );
  const composerLocked =
    Boolean(interaction) || Boolean(activePlan?.isAwaitingDecision && !isRefiningPlan);
  const isRunning = snapshot.status === "running";
  const isMutating = isPending || isSubmitting;
  const sendDisabled =
    draft.trim().length === 0 || isRunning || isMutating || (composerLocked && !isRefiningPlan);

  async function handleSend(
    text: string,
    mentionBindings: ComposerMentionBindingInput[],
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
          ...(mentionBindings.length > 0 ? { mentionBindings } : {}),
        });
        if (sent) {
          startTransition(() => {
            setDraft("");
            setMentionBindings([]);
          });
          setIsRefiningPlan(false);
        }
        return;
      }
      const sent = await sendMessage(thread.id, message, mentionBindings);
      if (sent) {
        startTransition(() => {
          setDraft("");
          setMentionBindings([]);
        });
      }
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
    }
  }

  async function handleApprovePlan() {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setIsSubmitting(true);
    try {
      const sent = await submitPlanDecision({
        threadId: thread.id,
        action: "approve",
        composer: { ...resolvedComposer, collaborationMode: "build" },
      });
      if (sent) {
        setIsRefiningPlan(false);
        startTransition(() => {
          setDraft("");
          setMentionBindings([]);
        });
      }
    } finally {
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
        {snapshot.items.length === 0 && !activePlan ? <ConversationEmpty /> : null}
        {snapshot.items.map((item) => (
          <ConversationItemRow key={item.id} item={item} />
        ))}
        {shouldRenderPlanCard && activePlan ? (
          <ConversationPlanCard
            plan={activePlan}
            disabled={isRunning || isMutating}
            onApprove={() => void handleApprovePlan()}
            onRefine={() => setIsRefiningPlan(true)}
          />
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
        queueCount={snapshot.pendingInteractions.length}
        onRespondApproval={(response) =>
          respondToApproval(thread.id, interaction?.id ?? "", response)
        }
        onSubmitAnswers={(answers) =>
          respondToUserInput(thread.id, interaction?.id ?? "", answers)
        }
      />
      <SubagentStrip subagents={snapshot.subagents} />
      <InlineComposer
        threadId={thread.id}
        composer={resolvedComposer}
        collaborationModes={capabilities?.collaborationModes ?? []}
        disabled={composerLocked && !isRefiningPlan}
        draft={draft}
        effortOptions={effortOptions}
        focusKey={thread.id}
        isBusy={isRunning || isPending}
        isSending={isSubmitting}
        isRefiningPlan={isRefiningPlan}
        mentionBindings={mentionBindings}
        modelOptions={capabilities?.models ?? []}
        tokenUsage={snapshot.tokenUsage}
        onCancelRefine={() => {
          setDraft("");
          setMentionBindings([]);
          setIsRefiningPlan(false);
        }}
        onChangeDraft={setDraft}
        onChangeMentionBindings={setMentionBindings}
        onInterrupt={() => void interruptThread(thread.id)}
        onSend={(text, mentionBindings) => void handleSend(text, mentionBindings)}
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

function ConversationItemRow({ item }: { item: ConversationItem }) {
  const [expanded, setExpanded] = useState(false);

  if (item.kind === "message") {
    const shouldRenderMarkdown = item.role === "assistant";
    const bodyClassName = [
      "tx-item__body",
      "tx-item__body--message",
      item.role === "user" ? "tx-item__body--message-plain" : null,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div className={`tx-item tx-item--message tx-item--${item.role}`}>
        <div className="tx-item__header">{item.role === "user" ? "You" : "Codex"}</div>
        {shouldRenderMarkdown ? (
          <ConversationMarkdown
            markdown={item.text}
            className={bodyClassName}
          />
        ) : (
          <div className={bodyClassName}>{item.text}</div>
        )}
      </div>
    );
  }

  if (item.kind === "reasoning") {
    if (!item.isStreaming && item.summary.length === 0 && item.content.length === 0) {
      return null;
    }

    return (
      <div className="tx-item tx-item--reasoning">
        <button
          type="button"
          className="tx-item__toggle"
          aria-label={expanded ? "Hide thinking details" : "Show thinking details"}
          onClick={() => setExpanded((value) => !value)}
        >
          <div className="tx-item__header">
            <span className="tx-item__header-main">
              <ChevronRightIcon
                size={12}
                className={`tx-item__chevron ${expanded ? "tx-item__chevron--expanded" : ""}`}
              />
              Thinking
            </span>
            <span className="tx-pill tx-pill--neutral">
              {expanded ? "Hide" : item.isStreaming ? "Thinking" : "Hidden"}
            </span>
          </div>
        </button>
        {expanded ? (
          <div className="tx-item__body">
            {item.summary ? (
              <ConversationMarkdown
                markdown={item.summary}
                className="tx-item__body tx-item__body--reasoning"
              />
            ) : null}
            {item.content ? (
              <ConversationMarkdown
                markdown={item.content}
                className="tx-item__body tx-item__body--reasoning"
              />
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (item.kind === "tool") {
    return (
      <div className="tx-item tx-item--tool">
        <button
          type="button"
          className="tx-item__toggle"
          aria-label={expanded ? `Hide ${item.title} details` : `Show ${item.title} details`}
          onClick={() => setExpanded((value) => !value)}
        >
          <div className="tx-item__header">
            <span className="tx-item__header-main">
              <ChevronRightIcon
                size={12}
                className={`tx-item__chevron ${expanded ? "tx-item__chevron--expanded" : ""}`}
              />
              {item.title}
            </span>
            <span className={`tx-pill tx-pill--${item.status}`}>
              {labelForItemStatus(item.status)}
            </span>
          </div>
          {item.summary ? <p className="tx-item__summary">{item.summary}</p> : null}
        </button>
        {expanded && item.output ? (
          <pre className="tx-item__body tx-item__body--tool">{item.output}</pre>
        ) : null}
      </div>
    );
  }

  return <ConversationBanner tone={item.tone} title={item.title} body={item.body} />;
}

function ConversationBanner({
  tone,
  title,
  body,
}: {
  tone: "info" | "warning" | "error";
  title: string;
  body: string;
}) {
  return (
    <div className={`tx-banner tx-banner--${tone}`}>
      <div className="tx-banner__title">{title}</div>
      <p className="tx-banner__body">{body}</p>
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

function labelForItemStatus(status: string) {
  if (status === "inProgress") return "Running";
  return status.charAt(0).toUpperCase() + status.slice(1);
}
