import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type {
  ConversationAutoApprovalReviewItem,
  ConversationItem,
  ConversationMessageItem,
  ProviderKind,
} from "../../lib/types";
import {
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderIcon,
  GlobeIcon,
  HammerIcon,
  ImageIcon,
  PencilIcon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
  type IconProps,
} from "../../shared/Icons";
import { SmoothCollapse } from "../../shared/SmoothCollapse";
import { ComposerTokenText } from "./ComposerTokenText";
import { ConversationLinkedText } from "./ConversationLinkedText";
import { ConversationMessageImages } from "./ConversationMessageImages";
import { ConversationMarkdown } from "./ConversationMarkdown";
import { shouldRenderConversationItem } from "./conversation-item-visibility";

type Props = {
  item: ConversationItem;
  compact?: boolean;
  provider?: ProviderKind;
};

export function ConversationItemRow({
  item,
  compact = false,
  provider = "codex",
}: Props) {
  const [expanded, setExpanded] = useState(false);

  if (item.kind === "message") {
    return <ConversationMessageRow item={item} compact={compact} provider={provider} />;
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
                size={11}
                className={`tx-item__chevron ${expanded ? "tx-item__chevron--expanded" : ""}`}
              />
              <BrainIcon size={13} className="tx-item__kind-icon" />
              <span className="tx-item__title">Thinking</span>
            </span>
          </div>
        </button>
        <SmoothCollapse open={expanded}>
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
        </SmoothCollapse>
      </div>
    );
  }

  if (item.kind === "tool") {
    const ToolIcon = iconForToolType(item.toolType);
    return (
      <div
        className={`tx-item tx-item--tool tx-item--tool-${slugifyToolType(item.toolType)} ${compact ? "tx-item--compact" : ""}`}
      >
        <button
          type="button"
          className="tx-item__toggle"
          aria-label={expanded ? `Hide ${item.title} details` : `Show ${item.title} details`}
          onClick={() => setExpanded((value) => !value)}
        >
          <div className="tx-item__header">
            <span className="tx-item__header-main">
              <ChevronRightIcon
                size={11}
                className={`tx-item__chevron ${expanded ? "tx-item__chevron--expanded" : ""}`}
              />
              <ToolIcon size={13} className="tx-item__kind-icon" />
              <span className="tx-item__title">{item.title}</span>
            </span>
          </div>
        </button>
        <SmoothCollapse open={expanded}>
          {item.summary ? (
            <ConversationLinkedText
              as="p"
              className="tx-item__summary"
              text={item.summary}
            />
          ) : null}
          {item.output ? (
            <ConversationLinkedText
              as="pre"
              className="tx-item__body tx-item__body--tool"
              text={item.output}
            />
          ) : null}
        </SmoothCollapse>
      </div>
    );
  }

  if (item.kind === "autoApprovalReview") {
    return (
      <AutoApprovalReviewRow
        item={item}
        compact={compact}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
    );
  }

  return <ConversationBanner tone={item.tone} title={item.title} body={item.body} compact={compact} />;
}

function AutoApprovalReviewRow({
  item,
  compact,
  expanded,
  onToggle,
}: {
  item: ConversationAutoApprovalReviewItem;
  compact: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const statusLabel = autoReviewStatusLabel(item.status);
  const riskLabel = item.riskLevel ? `Risk: ${autoReviewRiskLabel(item.riskLevel)}` : null;
  const authorizationLabel = item.userAuthorization
    ? `Auth: ${autoReviewAuthorizationLabel(item.userAuthorization)}`
    : null;
  const metaParts = [
    authorizationLabel,
    item.targetItemId ? `Target: ${item.targetItemId}` : null,
  ].filter(Boolean);
  const statusId = `${item.id}-auto-review-status`;
  const riskId = `${item.id}-auto-review-risk`;
  const describedBy = [riskLabel ? riskId : null, statusId]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`tx-item tx-item--auto-review ${compact ? "tx-item--compact" : ""}`}>
      <button
        type="button"
        className="tx-item__toggle"
        aria-label={expanded ? `Hide ${item.title} details` : `Show ${item.title} details`}
        aria-describedby={describedBy}
        onClick={onToggle}
      >
        <div className="tx-item__header">
          <span className="tx-item__header-main">
            <ChevronRightIcon
              size={11}
              className={`tx-item__chevron ${expanded ? "tx-item__chevron--expanded" : ""}`}
            />
            <SparklesIcon size={13} className="tx-item__kind-icon" />
            <span className="tx-item__title">{item.title}</span>
          </span>
          <span className="tx-auto-review__badges">
            {riskLabel ? (
              <span
                id={riskId}
                className={`tx-auto-review__badge tx-auto-review__badge--risk-${item.riskLevel}`}
              >
                {riskLabel}
              </span>
            ) : null}
            <span
              id={statusId}
              className={`tx-auto-review__badge tx-auto-review__badge--status-${item.status}`}
            >
              {statusLabel}
            </span>
          </span>
        </div>
      </button>
      <SmoothCollapse open={expanded}>
        {item.summary ? (
          <ConversationLinkedText
            as="pre"
            className="tx-item__body tx-item__body--auto-review"
            text={item.summary}
          />
        ) : null}
        {item.rationale ? (
          <ConversationLinkedText
            as="p"
            className="tx-auto-review__rationale"
            text={item.rationale}
          />
        ) : null}
        {metaParts.length > 0 ? (
          <p className="tx-auto-review__meta">{metaParts.join(" / ")}</p>
        ) : null}
      </SmoothCollapse>
    </div>
  );
}

const USER_MESSAGE_COLLAPSE_MAX_HEIGHT = 280;

function ConversationMessageRow({
  item,
  compact,
  provider,
}: {
  item: ConversationMessageItem;
  compact: boolean;
  provider: ProviderKind;
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
  }, [isCollapsible, item.text, hasImages, provider, compact]);

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
      <div className="tx-item__header">
        {item.role === "user" ? "You" : assistantLabelForProvider(provider)}
      </div>
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
            <div className={bodyClassName}>
              <ComposerTokenText
                text={item.text}
                provider={provider}
                decorateAllProviderTokens={item.role === "user"}
                decorateFileTokens={false}
                decorateUnknownTokens={item.role === "user"}
                mentionBindings={item.mentionBindings ?? []}
                keyPrefix={`message-${item.id}-collapsed`}
              />
            </div>
          ) : (
            <div className={bodyClassName}>
              <ComposerTokenText
                text={item.text}
                provider={provider}
                decorateAllProviderTokens={item.role === "user"}
                decorateFileTokens={false}
                decorateUnknownTokens={item.role === "user"}
                mentionBindings={item.mentionBindings ?? []}
                linkifyText
                keyPrefix={`message-${item.id}`}
              />
            </div>
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

function assistantLabelForProvider(provider: ProviderKind) {
  return provider === "claude" ? "Claude" : "Codex";
}

function autoReviewStatusLabel(status: ConversationAutoApprovalReviewItem["status"]) {
  switch (status) {
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    case "timedOut":
      return "Timed out";
    case "aborted":
      return "Stopped";
    default:
      return "Reviewing";
  }
}

function autoReviewRiskLabel(risk: NonNullable<ConversationAutoApprovalReviewItem["riskLevel"]>) {
  switch (risk) {
    case "critical":
      return "Critical";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    default:
      return risk;
  }
}

function autoReviewAuthorizationLabel(
  authorization: NonNullable<ConversationAutoApprovalReviewItem["userAuthorization"]>,
) {
  switch (authorization) {
    case "unknown":
      return "Unknown";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    default:
      return authorization;
  }
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

function iconForToolType(
  toolType: string,
): (props: IconProps) => React.ReactElement {
  const normalized = typeof toolType === "string" ? toolType.toLowerCase() : "";
  if (
    normalized === "commandexecution" ||
    normalized === "bash" ||
    normalized === "terminal" ||
    normalized.includes("shell")
  ) {
    return TerminalIcon;
  }
  if (
    normalized === "websearch" ||
    normalized === "webfetch" ||
    normalized.includes("search") ||
    normalized.includes("fetch") ||
    normalized.includes("browser")
  ) {
    return GlobeIcon;
  }
  if (
    normalized === "filechange" ||
    normalized === "edit" ||
    normalized === "write" ||
    normalized === "multiedit" ||
    normalized.includes("edit") ||
    normalized.includes("write")
  ) {
    return PencilIcon;
  }
  if (
    normalized === "read" ||
    normalized === "ls" ||
    normalized === "glob" ||
    normalized.includes("read") ||
    normalized.includes("list")
  ) {
    return FolderIcon;
  }
  if (normalized === "imageview" || normalized.includes("image")) {
    return ImageIcon;
  }
  if (normalized.includes("think") || normalized.includes("plan")) {
    return SparklesIcon;
  }
  if (normalized.includes("build") || normalized.includes("compile")) {
    return HammerIcon;
  }
  return WrenchIcon;
}

function slugifyToolType(toolType: string): string {
  return toolType
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .toLowerCase();
}
