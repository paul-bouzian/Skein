import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { ConversationItem, ConversationMessageItem } from "../../lib/types";
import { CheckIcon, ChevronRightIcon, CopyIcon } from "../../shared/Icons";
import { ConversationLinkedText } from "./ConversationLinkedText";
import { ConversationMessageImages } from "./ConversationMessageImages";
import { ConversationMarkdown } from "./ConversationMarkdown";
import { shouldRenderConversationItem } from "./conversation-item-visibility";

type Props = {
  item: ConversationItem;
  compact?: boolean;
};

export function ConversationItemRow({ item, compact = false }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (item.kind === "message") {
    return <ConversationMessageRow item={item} compact={compact} />;
  }

  if (item.kind === "reasoning") {
    if (!shouldRenderConversationItem(item)) {
      return null;
    }

    return (
      <div className={`tx-item tx-item--reasoning ${compact ? "tx-item--compact" : ""}`}>
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
      <div className={`tx-item tx-item--tool ${compact ? "tx-item--compact" : ""}`}>
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
        </button>
        {expanded && item.summary ? (
          <ConversationLinkedText
            as="p"
            className="tx-item__summary"
            text={item.summary}
          />
        ) : null}
        {expanded && item.output ? (
          <ConversationLinkedText
            as="pre"
            className="tx-item__body tx-item__body--tool"
            text={item.output}
          />
        ) : null}
      </div>
    );
  }

  return <ConversationBanner tone={item.tone} title={item.title} body={item.body} compact={compact} />;
}

const USER_MESSAGE_COLLAPSE_MAX_HEIGHT = 280;

function ConversationMessageRow({
  item,
  compact,
}: {
  item: ConversationMessageItem;
  compact: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const bodyWrapRef = useRef<HTMLDivElement | null>(null);
  const isMountedRef = useRef(true);
  const copyFeedbackTimeoutRef = useRef<number | null>(null);
  const shouldRenderMarkdown = item.role === "assistant";
  const hasText = item.text.trim().length > 0;
  const hasImages = Boolean(item.images && item.images.length > 0);
  const isUser = item.role === "user";
  const isCollapsible = isUser && hasText;
  const isCollapsed = isCollapsible && isOverflowing && !expanded;
  const className = [
    "tx-item",
    "tx-item--message",
    `tx-item--${item.role}`,
    compact ? "tx-item--compact" : null,
  ]
    .filter(Boolean)
    .join(" ");
  const bodyClassName = [
    "tx-item__body",
    "tx-item__body--message",
    item.role === "user" ? "tx-item__body--message-plain" : null,
  ]
    .filter(Boolean)
    .join(" ");
  const bodyWrapClassName = [
    "tx-item__body-wrap",
    isCollapsed ? "tx-item__body-wrap--collapsed" : null,
  ]
    .filter(Boolean)
    .join(" ");
  const copyButtonClassName = [
    "tx-item__copy-button",
    compact ? "tx-item__copy-button--compact" : null,
    copied ? "is-copied" : null,
  ]
    .filter(Boolean)
    .join(" ");

  const clearCopyFeedbackTimeout = useCallback(() => {
    if (copyFeedbackTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(copyFeedbackTimeoutRef.current);
    copyFeedbackTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      clearCopyFeedbackTimeout();
    };
  }, [clearCopyFeedbackTimeout]);

  useLayoutEffect(() => {
    if (!isCollapsible) {
      setIsOverflowing(false);
      return;
    }
    const element = bodyWrapRef.current;
    if (!element) {
      return;
    }
    // scrollHeight reports the full intrinsic height even when the
    // wrapper is clamped by max-height + overflow hidden, so comparing
    // against the collapse threshold detects overflow without needing to
    // toggle styles between measurements. Width changes (pane resize,
    // sidebar toggle, split pane) change the wrapped height, so re-measure
    // whenever the wrapper's own box resizes.
    const measure = () => {
      setIsOverflowing(element.scrollHeight > USER_MESSAGE_COLLAPSE_MAX_HEIGHT + 8);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [isCollapsible, item.text, hasImages]);

  const handleCopy = useCallback(async () => {
    if (!hasText) {
      return;
    }

    const clipboard = typeof navigator === "undefined" ? null : navigator.clipboard;
    if (!clipboard?.writeText) {
      return;
    }

    try {
      await clipboard.writeText(item.text);
      if (!isMountedRef.current) {
        return;
      }
      setCopied(true);
      clearCopyFeedbackTimeout();
      copyFeedbackTimeoutRef.current = window.setTimeout(() => {
        if (!isMountedRef.current) {
          return;
        }
        setCopied(false);
        copyFeedbackTimeoutRef.current = null;
      }, 1200);
    } catch {
      // Clipboard access can fail in restricted contexts; the UI should remain stable.
    }
  }, [clearCopyFeedbackTimeout, hasText, item.text]);

  return (
    <div className={className}>
      <div className="tx-item__header">{item.role === "user" ? "You" : "Codex"}</div>
      {hasImages ? <ConversationMessageImages images={item.images ?? []} /> : null}
      {shouldRenderMarkdown && hasText ? (
        <ConversationMarkdown markdown={item.text} className={bodyClassName} />
      ) : null}
      {!shouldRenderMarkdown && hasText ? (
        <div ref={bodyWrapRef} className={bodyWrapClassName}>
          {isCollapsed ? (
            // Collapsed = non-interactive preview. Render as plain text so
            // URLs below the fold don't sit in the tab order, and visible
            // URLs above the fold don't look clickable while the user is
            // still supposed to press "Show more" to interact with them.
            <div className={bodyClassName}>{item.text}</div>
          ) : (
            <ConversationLinkedText as="div" className={bodyClassName} text={item.text} />
          )}
        </div>
      ) : null}
      {isCollapsible && isOverflowing ? (
        <button
          type="button"
          className="tx-item__expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
      {hasText ? (
        <button
          type="button"
          className={copyButtonClassName}
          aria-label="Copy message"
          title="Copy message"
          onClick={() => {
            void handleCopy();
          }}
        >
          <span className="tx-item__copy-icon" aria-hidden="true">
            <CopyIcon size={14} className="tx-item__copy-icon-copy" />
            <CheckIcon size={14} className="tx-item__copy-icon-check" />
          </span>
        </button>
      ) : null}
    </div>
  );
}

export function ConversationBanner({
  tone,
  title,
  body,
  compact = false,
}: {
  tone: "info" | "warning" | "error";
  title: string;
  body: string;
  compact?: boolean;
}) {
  return (
    <div className={`tx-banner tx-banner--${tone} ${compact ? "tx-banner--compact" : ""}`}>
      <div className="tx-banner__title">{title}</div>
      <ConversationLinkedText as="p" className="tx-banner__body" text={body} />
    </div>
  );
}

function labelForItemStatus(status: string) {
  if (status === "inProgress") return "Running";
  return status.charAt(0).toUpperCase() + status.slice(1);
}
