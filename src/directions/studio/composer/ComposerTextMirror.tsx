import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { ProviderKind, ThreadComposerCatalog } from "../../../lib/types";
import { ComposerTokenText } from "../ComposerTokenText";

type Props = {
  draft: string;
  catalog: ThreadComposerCatalog | null;
  cursorIndex: number | null;
  placeholder: string;
  provider: ProviderKind;
  showCaret: boolean;
  scrollTop: number;
};

type CaretPosition = {
  left: number;
  top: number;
  height: number;
};

export function ComposerTextMirror({
  draft,
  catalog,
  cursorIndex,
  placeholder,
  provider,
  showCaret,
  scrollTop,
}: Props) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [caretPosition, setCaretPosition] = useState<CaretPosition | null>(
    null,
  );

  const updateCaretPosition = useCallback(() => {
    const content = contentRef.current;
    if (
      !showCaret ||
      cursorIndex === null ||
      draft.length === 0 ||
      !content
    ) {
      setCaretPosition(null);
      return;
    }
    const next = computeCaretPosition(content, cursorIndex);
    setCaretPosition((current) =>
      sameCaretPosition(current, next) ? current : next,
    );
  }, [showCaret, cursorIndex, draft]);

  // `catalog` and `provider` change the mirror DOM (badges, classes) without
  // changing the draft string, so they must invalidate the cached caret rect.
  useLayoutEffect(() => {
    updateCaretPosition();
  }, [updateCaretPosition, catalog, provider]);

  // Window resizes and pane width changes can rewrap the mirror without a
  // draft or cursor change; observe the content box to keep the caret aligned.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => updateCaretPosition());
    observer.observe(content);
    return () => observer.disconnect();
  }, [updateCaretPosition]);

  const isEmpty = draft.length === 0;

  return (
    <div className="tx-inline-composer__mirror" aria-hidden="true">
      <div
        ref={contentRef}
        className="tx-inline-composer__mirror-content"
        style={
          isEmpty ? undefined : { transform: `translateY(-${scrollTop}px)` }
        }
      >
        {isEmpty ? (
          <span className="tx-inline-composer__placeholder">{placeholder}</span>
        ) : (
          <ComposerTokenText
            text={draft}
            catalog={catalog}
            cursorIndex={cursorIndex}
            provider={provider}
            keyPrefix="composer-mirror"
          />
        )}
        <span> </span>
        {caretPosition ? (
          <span
            className="tx-inline-composer__visual-caret"
            style={caretPosition}
          />
        ) : null}
      </div>
    </div>
  );
}

function sameCaretPosition(
  a: CaretPosition | null,
  b: CaretPosition | null,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.left === b.left && a.top === b.top && a.height === b.height;
}

function computeCaretPosition(
  content: HTMLElement,
  cursorIndex: number,
): CaretPosition | null {
  const target = findSourceSpanForCursor(content, cursorIndex);
  if (!target) {
    return null;
  }
  const textNode = target.span.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  const textLength = textNode.textContent?.length ?? 0;
  const offset = Math.max(0, Math.min(textLength, cursorIndex - target.start));

  const rect = measureCaretRect(textNode, offset, textLength);
  if (!rect) {
    return null;
  }

  const contentRect = content.getBoundingClientRect();
  return {
    left: rect.left - contentRect.left,
    top: rect.top - contentRect.top,
    height: rect.height,
  };
}

function findSourceSpanForCursor(
  content: HTMLElement,
  cursorIndex: number,
): { span: HTMLElement; start: number } | null {
  let match: { span: HTMLElement; start: number } | null = null;
  for (const span of content.querySelectorAll<HTMLElement>(
    "[data-source-start]",
  )) {
    const start = Number(span.dataset.sourceStart);
    if (!Number.isFinite(start)) {
      continue;
    }
    const end = start + (span.textContent?.length ?? 0);
    if (cursorIndex < start || cursorIndex > end) {
      continue;
    }
    if (!match || start > match.start) {
      match = { span, start };
    }
  }
  return match;
}

type CaretRect = { left: number; top: number; height: number };

function measureCaretRect(
  textNode: Node,
  offset: number,
  textLength: number,
): CaretRect | null {
  const range = document.createRange();
  try {
    range.setStart(textNode, offset);
    range.setEnd(textNode, offset);
    const collapsed = range.getBoundingClientRect();
    if (collapsed.height > 0) {
      return {
        left: collapsed.left,
        top: collapsed.top,
        height: collapsed.height,
      };
    }
    // A collapsed range at a line wrap or end-of-text reports zero height in
    // some browsers; measure a neighboring character to recover line metrics.
    if (offset > 0) {
      range.setStart(textNode, offset - 1);
      range.setEnd(textNode, offset);
      const charRect = range.getBoundingClientRect();
      return { left: charRect.right, top: charRect.top, height: charRect.height };
    }
    if (textLength > 0) {
      range.setStart(textNode, 0);
      range.setEnd(textNode, 1);
      const charRect = range.getBoundingClientRect();
      return { left: charRect.left, top: charRect.top, height: charRect.height };
    }
    return null;
  } catch {
    return null;
  }
}
