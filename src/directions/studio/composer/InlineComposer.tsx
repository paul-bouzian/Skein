import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { getThreadComposerCatalog, searchThreadFiles } from "../../../lib/bridge";
import type {
  ComposerMentionBindingInput,
  ComposerFileSearchResult,
  ConversationComposerSettings,
  ModelOption,
  ThreadComposerCatalog,
  ThreadTokenUsageSnapshot,
} from "../../../lib/types";
import { SendIcon, StopIcon } from "../../../shared/Icons";
import { ComposerPicker } from "../ComposerPicker";
import { ContextWindowMeter } from "../ContextWindowMeter";
import {
  APPROVAL_OPTIONS,
  composerModelOptions,
  labelForCollaborationMode,
  reasoningOptionsFor,
} from "../composerOptions";
import { ComposerAutocompleteMenu } from "./ComposerAutocompleteMenu";
import {
  addComposerMentionBinding,
  prepareComposerMentionBindingsForSend,
  rebaseComposerMentionBindings,
  type ComposerDraftMentionBinding,
} from "./composer-mention-bindings";
import { ComposerTextMirror } from "./ComposerTextMirror";
import {
  buildAutocompleteItems,
  findActiveComposerToken,
  replaceComposerToken,
  type ComposerAutocompleteItem,
} from "./composer-model";

type Props = {
  threadId: string;
  composer: ConversationComposerSettings;
  collaborationModes: Array<{ id: string; label: string }>;
  disabled: boolean;
  draft: string;
  effortOptions: Array<"low" | "medium" | "high" | "xhigh">;
  focusKey: string;
  isBusy: boolean;
  isSending: boolean;
  isRefiningPlan: boolean;
  mentionBindings: ComposerDraftMentionBinding[];
  modelOptions: ModelOption[];
  tokenUsage?: ThreadTokenUsageSnapshot | null;
  onCancelRefine: () => void;
  onChangeDraft: (value: string) => void;
  onChangeMentionBindings: (bindings: ComposerDraftMentionBinding[]) => void;
  onInterrupt: () => void;
  onSend: (text: string, mentionBindings: ComposerMentionBindingInput[]) => void;
  onUpdateComposer: (patch: Partial<ConversationComposerSettings>) => void;
};

export function InlineComposer({
  threadId,
  composer,
  collaborationModes,
  disabled,
  draft,
  effortOptions,
  focusKey,
  isBusy,
  isSending,
  isRefiningPlan,
  mentionBindings,
  modelOptions,
  tokenUsage,
  onCancelRefine,
  onChangeDraft,
  onChangeMentionBindings,
  onInterrupt,
  onSend,
  onUpdateComposer,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileSearchRequestRef = useRef(0);
  const previousDraftRef = useRef(draft);
  const [catalog, setCatalog] = useState<ThreadComposerCatalog | null>(null);
  const [fileResults, setFileResults] = useState<ComposerFileSearchResult[]>([]);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedTokenKey, setDismissedTokenKey] = useState<string | null>(null);
  const [pendingCursor, setPendingCursor] = useState<number | null>(null);
  const isPlanMode = composer.collaborationMode === "plan";
  const nextMode: ConversationComposerSettings["collaborationMode"] = isPlanMode
    ? "build"
    : "plan";
  const canToggleMode = collaborationModes.some((option) => option.id === nextMode);
  const inputDisabled = isBusy || isSending || (disabled && !isRefiningPlan);
  const controlsDisabled = isBusy || isSending || disabled;
  const placeholder = isRefiningPlan
    ? "Refine the proposed plan..."
    : "Message ThreadEx...";

  useEffect(() => {
    let cancelled = false;
    void getThreadComposerCatalog(threadId)
      .then((nextCatalog) => {
        if (!cancelled) {
          setCatalog(nextCatalog);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element || element.disabled) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      element.focus();
      setSelection({
        start: element.selectionStart ?? 0,
        end: element.selectionEnd ?? 0,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusKey]);

  const activeToken = useMemo(
    () => findActiveComposerToken(draft, selection.start, selection.end),
    [draft, selection.end, selection.start],
  );
  const activeTokenKey = activeToken
    ? `${activeToken.kind}:${activeToken.start}:${activeToken.raw}`
    : null;

  useEffect(() => {
    if (activeTokenKey !== dismissedTokenKey) {
      setDismissedTokenKey(null);
    }
  }, [activeTokenKey, dismissedTokenKey]);

  useEffect(() => {
    if (previousDraftRef.current === draft) {
      return;
    }
    onChangeMentionBindings(
      rebaseComposerMentionBindings(previousDraftRef.current, draft, mentionBindings),
    );
    previousDraftRef.current = draft;
  }, [draft, mentionBindings, onChangeMentionBindings]);

  useEffect(() => {
    if (!activeToken || activeToken.kind !== "file") {
      fileSearchRequestRef.current += 1;
      setFileResults([]);
      return;
    }
    const requestId = fileSearchRequestRef.current + 1;
    fileSearchRequestRef.current = requestId;
    const timeout = window.setTimeout(() => {
      void searchThreadFiles({
        threadId,
        query: activeToken.query,
        limit: 50,
      })
        .then((results) => {
          if (fileSearchRequestRef.current === requestId) {
            setFileResults(results);
          }
        })
        .catch(() => {
          if (fileSearchRequestRef.current === requestId) {
            setFileResults([]);
          }
        });
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [activeToken, threadId]);

  const autocompleteItems = useMemo(
    () =>
      dismissedTokenKey === activeTokenKey
        ? []
        : buildAutocompleteItems(
            activeToken,
            catalog,
            fileResults.map((result) => result.path),
          ),
    [activeToken, activeTokenKey, catalog, dismissedTokenKey, fileResults],
  );
  const hasAutocompleteItems = autocompleteItems.length > 0;

  useEffect(() => {
    setActiveIndex((current) =>
      autocompleteItems.length === 0 ? 0 : Math.min(current, autocompleteItems.length - 1),
    );
  }, [autocompleteItems.length]);

  useEffect(() => {
    if (!menuRef.current) {
      return;
    }
    const active = menuRef.current.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, autocompleteItems]);

  useLayoutEffect(() => {
    if (pendingCursor === null) {
      return;
    }
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    element.focus();
    element.setSelectionRange(pendingCursor, pendingCursor);
    setSelection({ start: pendingCursor, end: pendingCursor });
    setPendingCursor(null);
  }, [draft, pendingCursor]);

  function syncSelection() {
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    setSelection({
      start: element.selectionStart ?? 0,
      end: element.selectionEnd ?? 0,
    });
  }

  function applyItem(item: ComposerAutocompleteItem) {
    if (!activeToken) {
      return;
    }
    const replacement = replaceComposerToken(draft, activeToken, item);
    const rebasedBindings = rebaseComposerMentionBindings(draft, replacement.text, mentionBindings);
    const nextBindings = addComposerMentionBinding(rebasedBindings, item, activeToken.start);
    onChangeMentionBindings(nextBindings);
    previousDraftRef.current = replacement.text;
    onChangeDraft(replacement.text);
    setPendingCursor(replacement.cursor);
    setDismissedTokenKey(null);
  }

  function sendDraft() {
    onSend(
      draft,
      prepareComposerMentionBindingsForSend(draft, mentionBindings),
    );
  }

  function collaborationModeLabel(
    mode: ConversationComposerSettings["collaborationMode"],
  ) {
    return (
      collaborationModes.find((option) => option.id === mode)?.label ??
      labelForCollaborationMode(mode)
    );
  }

  const currentModeLabel = collaborationModeLabel(composer.collaborationMode);
  const nextModeLabel = collaborationModeLabel(nextMode);

  return (
    <div className={`tx-composer ${isPlanMode ? "tx-composer--plan" : ""}`}>
      {hasAutocompleteItems ? (
        <div ref={menuRef}>
          <ComposerAutocompleteMenu
            items={autocompleteItems}
            activeIndex={activeIndex}
            onSelect={applyItem}
          />
        </div>
      ) : null}

      <div className="tx-composer__body">
        <div
          className={`tx-inline-composer ${inputDisabled ? "tx-inline-composer--disabled" : ""}`}
        >
          <ComposerTextMirror
            draft={draft}
            catalog={catalog}
            placeholder={placeholder}
            scrollTop={scrollTop}
          />
          <textarea
            ref={textareaRef}
            className="tx-inline-composer__textarea"
            rows={1}
            value={draft}
            aria-label={isRefiningPlan ? "Refine the proposed plan" : "Message ThreadEx"}
            placeholder={placeholder}
            disabled={inputDisabled}
            onChange={(event) => {
              const nextDraft = event.target.value;
              onChangeMentionBindings(
                rebaseComposerMentionBindings(
                  previousDraftRef.current,
                  nextDraft,
                  mentionBindings,
                ),
              );
              previousDraftRef.current = nextDraft;
              onChangeDraft(nextDraft);
              setSelection({
                start: event.target.selectionStart ?? 0,
                end: event.target.selectionEnd ?? 0,
              });
              setDismissedTokenKey(null);
            }}
            onClick={syncSelection}
            onKeyUp={syncSelection}
            onSelect={syncSelection}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return;
              }
              if (hasAutocompleteItems) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((current) => (current + 1) % autocompleteItems.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((current) =>
                    current === 0 ? autocompleteItems.length - 1 : current - 1,
                  );
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  applyItem(autocompleteItems[activeIndex] ?? autocompleteItems[0]);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissedTokenKey(activeTokenKey);
                  return;
                }
              }

              if (event.key === "Escape" && isRefiningPlan) {
                event.preventDefault();
                onCancelRefine();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendDraft();
              }
            }}
          />
        </div>
      </div>

      <div className="tx-composer__controls">
        <div className="tx-composer__controls-group">
          <ComposerPicker
            label="Model"
            value={composer.model}
            options={composerModelOptions(modelOptions, composer.model)}
            compact
            disabled={controlsDisabled}
            onChange={(value) => onUpdateComposer({ model: value })}
          />
          <ComposerPicker
            label="Thinking"
            value={composer.reasoningEffort}
            options={reasoningOptionsFor(effortOptions)}
            compact
            disabled={controlsDisabled}
            onChange={(value) =>
              onUpdateComposer({
                reasoningEffort: value as ConversationComposerSettings["reasoningEffort"],
              })
            }
          />
          <button
            type="button"
            className={`tx-composer__toggle ${isPlanMode ? "tx-composer__toggle--accent" : ""}`}
            aria-label={
              canToggleMode
                ? `Collaboration mode: ${currentModeLabel}. Switch to ${nextModeLabel}`
                : `Collaboration mode: ${currentModeLabel}`
            }
            title={canToggleMode ? `Switch to ${nextModeLabel}` : currentModeLabel}
            aria-pressed={isPlanMode}
            disabled={controlsDisabled || !canToggleMode}
            onClick={() => {
              if (!canToggleMode) {
                return;
              }
              onUpdateComposer({
                collaborationMode: nextMode,
              });
            }}
          >
            {currentModeLabel}
          </button>
          <ComposerPicker
            label="Access"
            value={composer.approvalPolicy}
            tone={composer.approvalPolicy === "fullAccess" ? "warning" : "default"}
            options={APPROVAL_OPTIONS}
            compact
            disabled={controlsDisabled}
            onChange={(value) =>
              onUpdateComposer({
                approvalPolicy: value as ConversationComposerSettings["approvalPolicy"],
              })
            }
          />
        </div>
        <div className="tx-composer__controls-right">
          <ContextWindowMeter usage={tokenUsage} />
          {isBusy ? (
            <button
              type="button"
              className="tx-composer__send-button tx-composer__send-button--secondary"
              aria-label="Stop generation"
              onClick={onInterrupt}
            >
              <StopIcon size={10} />
            </button>
          ) : (
            <button
              type="button"
              className="tx-composer__send-button"
              aria-label={isRefiningPlan ? "Refine plan" : "Send message"}
              disabled={draft.trim().length === 0 || inputDisabled}
              onClick={sendDraft}
            >
              <SendIcon size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
