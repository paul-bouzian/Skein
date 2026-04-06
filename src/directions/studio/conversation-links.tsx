import { Fragment, type MouseEvent, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

const EXTERNAL_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);
const DELIMITER_PAIRS = [
  { open: "(", close: ")" },
  { open: "[", close: "]" },
  { open: "{", close: "}" },
];

export function handleExternalLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
) {
  event.preventDefault();
  event.stopPropagation();

  if (!isValidExternalUrl(href)) {
    return;
  }

  void Promise.resolve(openUrl(href)).catch(() => undefined);
}

export function renderTextWithExternalLinks(text: string, keyPrefix: string): ReactNode[] {
  if (!text) {
    return [];
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null = null;

  EXTERNAL_URL_PATTERN.lastIndex = 0;
  while ((match = EXTERNAL_URL_PATTERN.exec(text)) !== null) {
    const rawUrl = match[0];
    const start = match.index;
    const { url, trailing } = trimTrailingUrl(rawUrl);
    if (!isValidExternalUrl(url)) {
      continue;
    }

    if (start > cursor) {
      nodes.push(
        <Fragment key={`${keyPrefix}-text-${cursor}`}>
          {text.slice(cursor, start)}
        </Fragment>,
      );
    }

    nodes.push(
      <a
        key={`${keyPrefix}-link-${start}`}
        className="tx-markdown__link"
        href={url}
        rel="noreferrer"
        onClick={(event) => handleExternalLinkClick(event, url)}
      >
        {url}
      </a>,
    );

    if (trailing) {
      nodes.push(
        <Fragment key={`${keyPrefix}-trailing-${start}`}>{trailing}</Fragment>,
      );
    }

    cursor = start + rawUrl.length;
  }

  if (cursor < text.length) {
    nodes.push(
      <Fragment key={`${keyPrefix}-text-${cursor}`}>{text.slice(cursor)}</Fragment>,
    );
  }

  return nodes;
}

function isValidExternalUrl(value: string) {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function trimTrailingUrl(rawUrl: string) {
  let end = rawUrl.length;

  while (end > 0) {
    const lastCharacter = rawUrl[end - 1];
    if (TRAILING_PUNCTUATION.has(lastCharacter)) {
      end -= 1;
      continue;
    }

    const delimiterPair = DELIMITER_PAIRS.find(
      ({ close }) => close === lastCharacter,
    );
    if (
      delimiterPair &&
      hasUnmatchedClosingDelimiter(
        rawUrl.slice(0, end),
        delimiterPair.open,
        delimiterPair.close,
      )
    ) {
      end -= 1;
      continue;
    }

    break;
  }

  return {
    url: rawUrl.slice(0, end),
    trailing: rawUrl.slice(end),
  };
}

function hasUnmatchedClosingDelimiter(value: string, open: string, close: string) {
  let openCount = 0;
  let closeCount = 0;

  for (const character of value) {
    if (character === open) {
      openCount += 1;
    } else if (character === close) {
      closeCount += 1;
    }
  }

  return closeCount > openCount;
}
