import { useEffect, useRef, useState, useTransition } from "react";

import type {
  ConversationComposerSettings,
  ConversationItem,
  ThreadTokenUsageSnapshot,
  EnvironmentRecord,
  ModelOption,
  ThreadRecord,
} from "../../lib/types";
import { EmptyState } from "../../shared/EmptyState";
import { ChevronRightIcon, SendIcon, StopIcon } from "../../shared/Icons";
import {
  selectConversationCapabilities,
  selectConversationComposer,
  selectConversationError,
  selectConversationSnapshot,
  useConversationStore,
} from "../../stores/conversation-store";
import { ComposerPicker } from "./ComposerPicker";
import { ConversationInteractionPanel } from "./ConversationInteractionPanel";
import { ConversationMeta } from "./ConversationMeta";
import { ConversationPlanCard } from "./ConversationPlanCard";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { SubagentStrip } from "./SubagentStrip";
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
  const [isRefiningPlan, setIsRefiningPlan] = useState(false);
  const [isPending, startTransition] = useTransition();
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const refreshInFlightRef = useRef(false);

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
  const sendDisabled =
    draft.trim().length === 0 || isRunning || (composerLocked && !isRefiningPlan);

  async function handleSend() {
    if (sendDisabled) return;
    const message = draft.trim();
    startTransition(() => setDraft(""));
    if (isRefiningPlan) {
      await submitPlanDecision({
        threadId: thread.id,
        action: "refine",
        feedback: message,
        composer: { ...resolvedComposer, collaborationMode: "plan" },
      });
      setIsRefiningPlan(false);
      return;
    }
    await sendMessage(thread.id, message);
  }

  async function handleApprovePlan() {
    setIsRefiningPlan(false);
    setDraft("");
    await submitPlanDecision({
      threadId: thread.id,
      action: "approve",
      composer: { ...resolvedComposer, collaborationMode: "build" },
    });
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
            disabled={isRunning || isPending}
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
      <ConversationComposer
        composer={resolvedComposer}
        collaborationModes={capabilities?.collaborationModes ?? []}
        disabled={composerLocked && !isRefiningPlan}
        draft={draft}
        effortOptions={effortOptions}
        focusKey={thread.id}
        isBusy={isRunning || isPending}
        isRefiningPlan={isRefiningPlan}
        modelOptions={capabilities?.models ?? []}
        tokenUsage={snapshot.tokenUsage}
        onCancelRefine={() => {
          setDraft("");
          setIsRefiningPlan(false);
        }}
        onChangeDraft={setDraft}
        onInterrupt={() => void interruptThread(thread.id)}
        onSend={() => void handleSend()}
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

function ConversationComposer({
  composer,
  collaborationModes,
  disabled,
  draft,
  effortOptions,
  focusKey,
  isBusy,
  isRefiningPlan,
  modelOptions,
  tokenUsage,
  onCancelRefine,
  onChangeDraft,
  onInterrupt,
  onSend,
  onUpdateComposer,
}: {
  composer: ConversationComposerSettings;
  collaborationModes: Array<{ id: string; label: string }>;
  disabled: boolean;
  draft: string;
  effortOptions: Array<"low" | "medium" | "high" | "xhigh">;
  focusKey: string;
  isBusy: boolean;
  isRefiningPlan: boolean;
  modelOptions: ModelOption[];
  tokenUsage?: ThreadTokenUsageSnapshot | null;
  onCancelRefine: () => void;
  onChangeDraft: (value: string) => void;
  onInterrupt: () => void;
  onSend: () => void;
  onUpdateComposer: (patch: Partial<ConversationComposerSettings>) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const controlsDisabled = isBusy || disabled;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    const nextHeight = Math.min(element.scrollHeight, 240);
    element.style.height = `${Math.max(nextHeight, 46)}px`;
    element.style.overflowY = element.scrollHeight > 240 ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element || element.disabled) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      element.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [focusKey]);

  return (
    <div className="tx-composer">
      <div className="tx-composer__controls">
        <div className="tx-composer__controls-group">
          <ComposerPicker
            label="Model"
            value={composer.model}
            options={modelOptions.map((option) => ({
              label: option.displayName,
              value: option.id,
            }))}
            disabled={controlsDisabled}
            onChange={(value) => onUpdateComposer({ model: value })}
          />
          <ComposerPicker
            label="Thinking"
            value={composer.reasoningEffort}
            options={effortOptions.map((effort) => ({
              label: effortLabel(effort),
              value: effort,
            }))}
            disabled={controlsDisabled}
            onChange={(value) =>
              onUpdateComposer({
                reasoningEffort: value as ConversationComposerSettings["reasoningEffort"],
              })
            }
          />
          <ComposerPicker
            label="Mode"
            value={composer.collaborationMode}
            tone={composer.collaborationMode === "plan" ? "accent" : "default"}
            options={collaborationModes.map((option) => ({
              label: option.label,
              value: option.id,
            }))}
            disabled={controlsDisabled}
            onChange={(value) =>
              onUpdateComposer({
                collaborationMode: value as ConversationComposerSettings["collaborationMode"],
              })
            }
          />
          <ComposerPicker
            label="Access"
            value={composer.approvalPolicy}
            options={[
              { label: "Ask to Edit", value: "askToEdit" },
              { label: "Full Access", value: "fullAccess" },
            ]}
            disabled={controlsDisabled}
            onChange={(value) =>
              onUpdateComposer({
                approvalPolicy: value as ConversationComposerSettings["approvalPolicy"],
              })
            }
          />
        </div>
        <ContextWindowMeter usage={tokenUsage} />
      </div>
      <div className="tx-composer__body">
        <div className="tx-composer__input-row">
          <textarea
            ref={textareaRef}
            className="tx-composer__textarea"
            placeholder={isRefiningPlan ? "Refine the proposed plan..." : "Message ThreadEx..."}
            rows={1}
            value={draft}
            disabled={isBusy || (disabled && !isRefiningPlan)}
            onChange={(event) => onChangeDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && isRefiningPlan) {
                event.preventDefault();
                onCancelRefine();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          {isBusy ? (
            <button
              type="button"
              className="tx-composer__icon-button tx-composer__icon-button--secondary"
              aria-label="Stop generation"
              onClick={onInterrupt}
            >
              <StopIcon size={12} />
            </button>
          ) : (
            <button
              type="button"
              className="tx-composer__icon-button"
              aria-label={isRefiningPlan ? "Refine plan" : "Send message"}
              disabled={draft.trim().length === 0 || (disabled && !isRefiningPlan)}
              onClick={onSend}
            >
              <SendIcon size={14} />
            </button>
          )}
        </div>
        <div className="tx-composer__actions">
          <span className="tx-composer__hint">
            {isRefiningPlan
              ? "Enter to refine · Escape to leave refine mode"
              : "Enter to send · Shift+Enter for newline"}
          </span>
        </div>
      </div>
    </div>
  );
}

function ConversationItemRow({ item }: { item: ConversationItem }) {
  const [expanded, setExpanded] = useState(false);

  if (item.kind === "message") {
    return (
      <div className={`tx-item tx-item--message tx-item--${item.role}`}>
        <div className="tx-item__header">{item.role === "user" ? "You" : "Codex"}</div>
        <div className="tx-item__body tx-item__body--message">{item.text}</div>
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
            {item.summary ? <p>{item.summary}</p> : null}
            {item.content ? <pre>{item.content}</pre> : null}
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

function effortLabel(value: string) {
  if (value === "xhigh") return "Extra High";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function labelForItemStatus(status: string) {
  if (status === "inProgress") return "Running";
  return status.charAt(0).toUpperCase() + status.slice(1);
}
