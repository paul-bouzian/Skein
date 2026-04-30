import { Fragment } from "react";

import type { ProviderKind, ThreadComposerCatalog } from "../../lib/types";
import {
  CubeIcon,
  FolderIcon,
  GlobeIcon,
  HammerIcon,
} from "../../shared/Icons";
import { renderTextWithExternalLinks } from "./conversation-links";
import {
  decorateComposerText,
  type ComposerMirrorSegment,
  PROMPT_PREFIX,
} from "./composer/composer-model";

type ComposerTokenTextProps = {
  text: string;
  catalog?: ThreadComposerCatalog | null;
  provider: ProviderKind;
  cursorIndex?: number | null;
  decorateAllProviderTokens?: boolean;
  decorateUnknownTokens?: boolean;
  keyPrefix: string;
  linkifyText?: boolean;
  showCaret?: boolean;
};

export function ComposerTokenText({
  text,
  catalog = null,
  provider,
  cursorIndex = null,
  decorateAllProviderTokens = false,
  decorateUnknownTokens = false,
  keyPrefix,
  linkifyText = false,
  showCaret = false,
}: ComposerTokenTextProps) {
  const segments = decorateComposerText(text, catalog, provider, {
    decorateAllProviderTokens,
    decorateUnknownTokens,
  });
  let sourceCursor = 0;
  let caretRendered = false;

  return (
    <>
      {segments.map((segment, index) => {
        const range =
          segment.kind === "text"
            ? {
                start: sourceCursor,
                end: sourceCursor + segment.text.length,
              }
            : { start: segment.start, end: segment.end };
        sourceCursor = range.end;
        const renderCaret =
          showCaret &&
          cursorIndex !== null &&
          !caretRendered &&
          cursorIndex >= range.start &&
          cursorIndex <= range.end;
        if (renderCaret) {
          caretRendered = true;
        }
        return renderComposerSegment(
          segment,
          `${keyPrefix}-${index}`,
          linkifyText,
          renderCaret ? cursorIndex : null,
          range,
        );
      })}
      {showCaret && cursorIndex === text.length && !caretRendered ? (
        <ComposerMirrorCaret />
      ) : null}
    </>
  );
}

function renderComposerSegment(
  segment: ComposerMirrorSegment,
  key: string,
  linkifyText: boolean,
  cursorIndex: number | null,
  range: { start: number; end: number },
) {
  if (segment.kind === "text") {
    if (cursorIndex !== null) {
      const localCursor = Math.max(
        0,
        Math.min(segment.text.length, cursorIndex - range.start),
      );
      const before = segment.text.slice(0, localCursor);
      const after = segment.text.slice(localCursor);
      return (
        <Fragment key={key}>
          {linkifyText ? renderTextWithExternalLinks(before, `${key}-before`) : before}
          <ComposerMirrorCaret />
          {linkifyText ? renderTextWithExternalLinks(after, `${key}-after`) : after}
        </Fragment>
      );
    }
    return (
      <Fragment key={key}>
        {linkifyText
          ? renderTextWithExternalLinks(segment.text, key)
          : segment.text}
      </Fragment>
    );
  }

  if (cursorIndex !== null && cursorIndex <= range.start) {
    return (
      <Fragment key={key}>
        <ComposerMirrorCaret />
        <ComposerTokenBadge segment={segment} />
      </Fragment>
    );
  }

  if (cursorIndex !== null && cursorIndex < range.end) {
    const display = displayForComposerToken(segment);
    const localCursor = Math.max(
      0,
      Math.min(segment.text.length, cursorIndex - range.start),
    );
    return (
      <Fragment key={key}>
        <span className={`tx-inline-token tx-inline-token--${display.tone}`}>
          {segment.text.slice(0, localCursor)}
          <ComposerMirrorCaret />
          {segment.text.slice(localCursor)}
        </span>
      </Fragment>
    );
  }

  return (
    <Fragment key={key}>
      <ComposerTokenBadge segment={segment} />
      {cursorIndex !== null ? <ComposerMirrorCaret /> : null}
    </Fragment>
  );
}

function ComposerTokenBadge({
  segment,
}: {
  segment: Exclude<ComposerMirrorSegment, { kind: "text" }>;
}) {
  const display = displayForComposerToken(segment);
  const Icon = iconForComposerToken(segment);
  const classes = [
    "tx-inline-token",
    "tx-inline-token-badge",
    `tx-inline-token--${display.tone}`,
  ].join(" ");

  return (
    <span className={classes} title={segment.text}>
      <Icon size={12} className="tx-inline-token-badge__icon" />
      <span className="tx-inline-token-badge__label">{display.label}</span>
      {display.detail ? (
        <span className="tx-inline-token-badge__detail">{display.detail}</span>
      ) : null}
    </span>
  );
}

function ComposerMirrorCaret() {
  return <span className="tx-inline-composer__visual-caret" />;
}

function displayForComposerToken(
  segment: Exclude<ComposerMirrorSegment, { kind: "text" }>,
) {
  if (segment.kind === "prompt") {
    const promptDisplay = displayForPromptToken(segment.text);
    return {
      label: promptDisplay.label,
      detail: promptDisplay.detail,
      tone: promptDisplay.tone,
    };
  }

  if (segment.kind === "file") {
    return {
      label: segment.text,
      detail: null,
      tone: "file",
    };
  }

  return {
    label: segment.text,
    detail: null,
    tone: segment.kind,
  };
}

function displayForPromptToken(text: string) {
  if (!text.startsWith(PROMPT_PREFIX)) {
    return {
      label: text,
      detail: null,
      tone: "command",
    };
  }

  const openIndex = text.indexOf("(");
  const nameEnd = openIndex === -1 ? text.length : openIndex;
  const name = text.slice(PROMPT_PREFIX.length, nameEnd);
  const rawDetail = openIndex === -1 ? "" : text.slice(openIndex);
  return {
    label: `/${name}`,
    detail: rawDetail === "()" ? null : rawDetail,
    tone: "prompt",
  };
}

function iconForComposerToken(
  segment: Exclude<ComposerMirrorSegment, { kind: "text" }>,
) {
  if (segment.kind === "skill") {
    return HammerIcon;
  }
  if (segment.kind === "app") {
    return GlobeIcon;
  }
  if (segment.kind === "file") {
    return FolderIcon;
  }
  return CubeIcon;
}
