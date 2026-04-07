import { useState } from "react";

import type { ConversationItem } from "../../lib/types";
import { ChevronRightIcon } from "../../shared/Icons";
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
    const shouldRenderMarkdown = item.role === "assistant";
    const hasText = item.text.trim().length > 0;
    const hasImages = Boolean(item.images && item.images.length > 0);
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

    return (
      <div className={className}>
        <div className="tx-item__header">{item.role === "user" ? "You" : "Codex"}</div>
        {hasImages ? <ConversationMessageImages images={item.images ?? []} /> : null}
        {shouldRenderMarkdown && hasText ? (
          <ConversationMarkdown
            markdown={item.text}
            className={bodyClassName}
          />
        ) : null}
        {!shouldRenderMarkdown && hasText ? (
          <ConversationLinkedText
            as="div"
            className={bodyClassName}
            text={item.text}
          />
        ) : null}
      </div>
    );
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
        {item.summary ? (
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
