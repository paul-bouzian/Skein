import { useEffect, useRef, useState, useTransition } from "react";

import {
  useConversationStore,
  selectConversationCapabilities,
  selectConversationComposer,
  selectConversationError,
  selectConversationSnapshot,
} from "../../stores/conversation-store";
import { EmptyState } from "../../shared/EmptyState";
import { ChevronRightIcon, SendIcon, StopIcon } from "../../shared/Icons";
import type {
  CollaborationModeOption,
  ConversationComposerSettings,
  ConversationItem,
  EnvironmentRecord,
  ModelOption,
  ThreadConversationSnapshot,
  ThreadRecord,
} from "../../lib/types";
import { ComposerPicker } from "./ComposerPicker";
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
  const loading = useConversationStore((s) => s.loadingByThreadId[thread.id] ?? false);
  const storeError = useConversationStore(selectConversationError(thread.id));
  const openThread = useConversationStore((s) => s.openThread);
  const updateComposer = useConversationStore((s) => s.updateComposer);
  const sendMessage = useConversationStore((s) => s.sendMessage);
  const interruptThread = useConversationStore((s) => s.interruptThread);
  const [draft, setDraft] = useState("");
  const [isPending, startTransition] = useTransition();
  const timelineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void openThread(thread.id);
  }, [openThread, thread.id]);

  useEffect(() => {
    const element = timelineRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [snapshot?.items.length, snapshot?.status]);

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
  const modelOptions = capabilities?.models ?? [];
  const selectedModel =
    modelOptions.find((candidate) => candidate.id === resolvedComposer.model) ?? null;
  const effortOptions = selectedModel?.supportedReasoningEfforts ?? [
    resolvedComposer.reasoningEffort,
  ];
  const collaborationModes = capabilities?.collaborationModes ?? [];
  const isPlanMode = resolvedComposer.collaborationMode === "plan";
  const isRunning = snapshot.status === "running";
  const canSend = draft.trim().length > 0 && !isRunning && !isPlanMode;

  async function handleSend() {
    if (!canSend) return;
    const message = draft.trim();
    startTransition(() => setDraft(""));
    await sendMessage(thread.id, message);
  }

  return (
    <div className="tx-conversation">
      <ConversationMeta
        snapshot={snapshot}
        environment={environment}
        thread={thread}
      />
      <div ref={timelineRef} className="tx-conversation__timeline">
        {snapshot.items.length === 0 ? <ConversationEmpty /> : null}
        {snapshot.items.map((item) => (
          <ConversationItemRow key={item.id} item={item} />
        ))}
        {snapshot.blockedInteraction ? (
          <ConversationBanner
            tone="warning"
            title={snapshot.blockedInteraction.title}
            body={snapshot.blockedInteraction.message}
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
      <ConversationComposer
        composer={resolvedComposer}
        collaborationModes={collaborationModes}
        draft={draft}
        effortOptions={effortOptions}
        isBusy={isRunning || isPending}
        modelOptions={modelOptions}
        onChangeDraft={setDraft}
        onInterrupt={() => void interruptThread(thread.id)}
        onSend={() => void handleSend()}
        onUpdateComposer={(patch) => updateComposer(thread.id, patch)}
      />
    </div>
  );
}

function ConversationMeta({
  snapshot,
  environment,
  thread,
}: {
  snapshot: ThreadConversationSnapshot;
  environment: EnvironmentRecord;
  thread: ThreadRecord;
}) {
  return (
    <div className="tx-conversation__meta">
      <div>
        <h2 className="tx-conversation__title">{thread.title}</h2>
        <p className="tx-conversation__subtitle">
          {environment.name}
          {snapshot.codexThreadId ? <> · {snapshot.codexThreadId}</> : null}
        </p>
      </div>
      <div className="tx-conversation__status-group">
        <span className={`tx-pill tx-pill--${snapshot.status}`}>
          {labelForStatus(snapshot.status)}
        </span>
        {snapshot.tokenUsage ? (
          <span className="tx-pill tx-pill--neutral">
            {snapshot.tokenUsage.total.totalTokens.toLocaleString()} tokens
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ConversationComposer({
  composer,
  collaborationModes,
  draft,
  effortOptions,
  isBusy,
  modelOptions,
  onChangeDraft,
  onInterrupt,
  onSend,
  onUpdateComposer,
}: {
  composer: ConversationComposerSettings;
  collaborationModes: CollaborationModeOption[];
  draft: string;
  effortOptions: Array<"low" | "medium" | "high" | "xhigh">;
  isBusy: boolean;
  modelOptions: ModelOption[];
  onChangeDraft: (value: string) => void;
  onInterrupt: () => void;
  onSend: () => void;
  onUpdateComposer: (patch: Partial<ConversationComposerSettings>) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    const nextHeight = Math.min(element.scrollHeight, 240);
    element.style.height = `${Math.max(nextHeight, 46)}px`;
    element.style.overflowY = element.scrollHeight > 240 ? "auto" : "hidden";
  }, [draft]);

  return (
    <div className="tx-composer">
      <div className="tx-composer__controls">
        <ComposerPicker
          label="Model"
          value={composer.model}
          options={modelOptions.map((option) => ({
            label: option.displayName,
            value: option.id,
          }))}
          disabled={isBusy}
          onChange={(value) => onUpdateComposer({ model: value })}
        />
        <ComposerPicker
          label="Thinking"
          value={composer.reasoningEffort}
          options={effortOptions.map((effort) => ({
            label: effortLabel(effort),
            value: effort,
          }))}
          disabled={isBusy}
          onChange={(value) =>
            onUpdateComposer({
              reasoningEffort: value as ConversationComposerSettings["reasoningEffort"],
            })
          }
        />
        <ComposerPicker
          label="Mode"
          value={composer.collaborationMode}
          options={collaborationModes.map((option) => ({
            label: option.label,
            value: option.id,
          }))}
          disabled={isBusy}
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
          disabled={isBusy}
          onChange={(value) =>
            onUpdateComposer({
              approvalPolicy: value as ConversationComposerSettings["approvalPolicy"],
            })
          }
        />
      </div>
      {composer.collaborationMode === "plan" ? (
        <ConversationBanner
          tone="warning"
          title="Plan mode comes next"
          body="This milestone only ships real Build-mode conversations. Switch back to Build to send."
        />
      ) : null}
      <div className="tx-composer__body">
        <div className="tx-composer__input-row">
          <textarea
            ref={textareaRef}
            className="tx-composer__textarea"
            placeholder="Message ThreadEx..."
            rows={1}
            value={draft}
            disabled={isBusy}
            onChange={(event) => onChangeDraft(event.target.value)}
            onKeyDown={(event) => {
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
              aria-label="Send message"
              disabled={draft.trim().length === 0 || composer.collaborationMode === "plan"}
              onClick={onSend}
            >
              <SendIcon size={14} />
            </button>
          )}
        </div>
        <div className="tx-composer__actions">
          <span className="tx-composer__hint">Enter to send · Shift+Enter for newline</span>
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
          aria-label={
            expanded ? `Hide ${item.title} details` : `Show ${item.title} details`
          }
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

  return (
    <ConversationBanner tone={item.tone} title={item.title} body={item.body} />
  );
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
      <p>Build mode is wired to the real Codex app-server. Use the composer below to start.</p>
    </div>
  );
}

function effortLabel(value: string) {
  if (value === "xhigh") return "Extra High";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function labelForStatus(status: string) {
  if (status === "waitingForExternalAction") return "Blocked";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function labelForItemStatus(status: string) {
  if (status === "inProgress") return "Running";
  return status.charAt(0).toUpperCase() + status.slice(1);
}
