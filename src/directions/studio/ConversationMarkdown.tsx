import { Fragment, type ReactNode } from "react";
import {
  handleExternalLinkClick,
  renderTextWithExternalLinks,
} from "./conversation-links";

type Props = {
  markdown: string;
  className?: string;
};

type HeadingDepth = 1 | 2 | 3 | 4 | 5 | 6;

type MarkdownBlock =
  | { kind: "heading"; depth: HeadingDepth; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "unorderedList"; items: string[] }
  | { kind: "orderedList"; items: string[] }
  | { kind: "blockquote"; text: string }
  | { kind: "codeBlock"; code: string };

type InlineTokenKind = "code" | "link" | "strong" | "emphasis";

type InlineTokenMatch = {
  kind: InlineTokenKind;
  start: number;
  end: number;
  captures: string[];
};

const FENCE_PATTERN = /^```([a-zA-Z0-9_+-]+)?\s*$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const UNORDERED_LIST_PATTERN = /^[-*]\s+(.*)$/;
const ORDERED_LIST_PATTERN = /^\d+\.\s+(.*)$/;
const BLOCKQUOTE_PATTERN = /^>\s?(.*)$/;
export function ConversationMarkdown({ markdown, className }: Props) {
  const blocks = parseMarkdownBlocks(markdown);
  const classes = ["tx-markdown", className].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
}

function renderBlock(block: MarkdownBlock, index: number) {
  if (block.kind === "heading") {
    const HeadingTag = headingTagForDepth(block.depth);

    return (
      <HeadingTag
        key={`${block.kind}-${index}`}
        className={`tx-markdown__heading tx-markdown__heading--${block.depth}`}
      >
        {renderInlineMarkdown(block.text, `${block.kind}-${index}`)}
      </HeadingTag>
    );
  }

  if (block.kind === "unorderedList") {
    return (
      <ul key={`${block.kind}-${index}`} className="tx-markdown__list">
        {block.items.map((item, itemIndex) => (
          <li key={`${block.kind}-${index}-${itemIndex}`}>
            {renderInlineMarkdown(item, `${block.kind}-${index}-${itemIndex}`)}
          </li>
        ))}
      </ul>
    );
  }

  if (block.kind === "orderedList") {
    return (
      <ol key={`${block.kind}-${index}`} className="tx-markdown__list">
        {block.items.map((item, itemIndex) => (
          <li key={`${block.kind}-${index}-${itemIndex}`}>
            {renderInlineMarkdown(item, `${block.kind}-${index}-${itemIndex}`)}
          </li>
        ))}
      </ol>
    );
  }

  if (block.kind === "blockquote") {
    return (
      <blockquote key={`${block.kind}-${index}`} className="tx-markdown__blockquote">
        {renderInlineMarkdown(block.text, `${block.kind}-${index}`)}
      </blockquote>
    );
  }

  if (block.kind === "codeBlock") {
    return (
      <pre key={`${block.kind}-${index}`} className="tx-markdown__code-block">
        <code>{block.code}</code>
      </pre>
    );
  }

  return (
    <p key={`${block.kind}-${index}`} className="tx-markdown__paragraph">
      {renderInlineMarkdown(block.text, `${block.kind}-${index}`)}
    </p>
  );
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const currentLine = lines[index] ?? "";
    const trimmed = currentLine.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (FENCE_PATTERN.test(trimmed)) {
      const [codeBlock, nextIndex] = consumeCodeBlock(lines, index);
      blocks.push(codeBlock);
      index = nextIndex;
      continue;
    }

    const heading = trimmed.match(HEADING_PATTERN);
    if (heading) {
      blocks.push({
        kind: "heading",
        depth: Math.min(heading[1].length, 6) as HeadingDepth,
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    if (UNORDERED_LIST_PATTERN.test(trimmed)) {
      const [items, nextIndex] = consumeListItems(lines, index, UNORDERED_LIST_PATTERN);
      if (items.length > 0) {
        blocks.push({ kind: "unorderedList", items });
      }
      index = nextIndex;
      continue;
    }

    if (ORDERED_LIST_PATTERN.test(trimmed)) {
      const [items, nextIndex] = consumeListItems(lines, index, ORDERED_LIST_PATTERN);
      if (items.length > 0) {
        blocks.push({ kind: "orderedList", items });
      }
      index = nextIndex;
      continue;
    }

    if (BLOCKQUOTE_PATTERN.test(trimmed)) {
      const [text, nextIndex] = consumeBlockquote(lines, index);
      blocks.push({ kind: "blockquote", text });
      index = nextIndex;
      continue;
    }

    const [text, nextIndex] = consumeParagraph(lines, index);
    blocks.push({ kind: "paragraph", text });
    index = nextIndex;
  }

  return blocks;
}

function consumeCodeBlock(lines: string[], startIndex: number) {
  const codeLines: string[] = [];
  let index = startIndex + 1;

  while (index < lines.length) {
    const candidate = lines[index] ?? "";
    if (FENCE_PATTERN.test(candidate.trim())) {
      return [
        {
          kind: "codeBlock",
          code: codeLines.join("\n"),
        } satisfies MarkdownBlock,
        index + 1,
      ] as const;
    }
    codeLines.push(candidate);
    index += 1;
  }

  return [
    {
      kind: "codeBlock",
      code: codeLines.join("\n"),
    } satisfies MarkdownBlock,
    index,
  ] as const;
}

function consumeListItems(lines: string[], startIndex: number, pattern: RegExp) {
  const items: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const candidate = lines[index]?.trim() ?? "";
    const match = candidate.match(pattern);
    if (!match) {
      break;
    }

    const item = match[1]?.trim() ?? "";
    if (item) {
      items.push(item);
    }
    index += 1;
  }

  return [items, index] as const;
}

function consumeBlockquote(lines: string[], startIndex: number) {
  const items: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const candidate = lines[index]?.trim() ?? "";
    const match = candidate.match(BLOCKQUOTE_PATTERN);
    if (!match) {
      break;
    }
    const item = match[1]?.trim() ?? "";
    if (item) {
      items.push(item);
    }
    index += 1;
  }

  return [items.join(" "), index] as const;
}

function consumeParagraph(lines: string[], startIndex: number) {
  const paragraphLines: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const candidate = lines[index] ?? "";
    const trimmed = candidate.trim();
    if (!trimmed || isBlockStart(trimmed)) {
      break;
    }
    paragraphLines.push(trimmed);
    index += 1;
  }

  return [paragraphLines.join(" "), index] as const;
}

function isBlockStart(trimmedLine: string) {
  return (
    FENCE_PATTERN.test(trimmedLine) ||
    HEADING_PATTERN.test(trimmedLine) ||
    UNORDERED_LIST_PATTERN.test(trimmedLine) ||
    ORDERED_LIST_PATTERN.test(trimmedLine) ||
    BLOCKQUOTE_PATTERN.test(trimmedLine)
  );
}

function headingTagForDepth(depth: HeadingDepth) {
  switch (depth) {
    case 1:
      return "h1";
    case 2:
      return "h2";
    case 3:
      return "h3";
    case 4:
      return "h4";
    case 5:
      return "h5";
    default:
      return "h6";
  }
}

function renderInlineMarkdown(
  text: string,
  keyPrefix: string,
  options: { linkifyPlainText?: boolean } = {},
) {
  if (!text) {
    return null;
  }

  const { linkifyPlainText = true } = options;
  const nodes: ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const token = findNextInlineToken(text, cursor);
    if (!token) {
      nodes.push(
        ...renderPlainTextSegment(
          text.slice(cursor),
          `${keyPrefix}-text-${cursor}`,
          linkifyPlainText,
        ),
      );
      break;
    }

    if (token.start > cursor) {
      nodes.push(
        ...renderPlainTextSegment(
          text.slice(cursor, token.start),
          `${keyPrefix}-text-${cursor}`,
          linkifyPlainText,
        ),
      );
    }

    const key = `${keyPrefix}-${token.kind}-${token.start}`;
    if (token.kind === "code") {
      nodes.push(
        <code key={key} className="tx-markdown__code">
          {token.captures[0]}
        </code>,
      );
    } else if (token.kind === "link") {
      nodes.push(
        <a
          key={key}
          className="tx-markdown__link"
          href={token.captures[1]}
          rel="noreferrer"
          onClick={(event) => handleExternalLinkClick(event, token.captures[1])}
        >
          {renderInlineMarkdown(token.captures[0], key, {
            linkifyPlainText: false,
          })}
        </a>,
      );
    } else if (token.kind === "strong") {
      nodes.push(
        <strong key={key}>
          {renderInlineMarkdown(token.captures[0], key)}
        </strong>,
      );
    } else {
      nodes.push(
        <em key={key}>
          {renderInlineMarkdown(token.captures[0], key)}
        </em>,
      );
    }

    cursor = token.end;
  }

  return nodes;
}

function renderPlainTextSegment(
  text: string,
  keyPrefix: string,
  linkifyPlainText: boolean,
) {
  if (!text) {
    return [];
  }

  if (!linkifyPlainText) {
    return [<Fragment key={keyPrefix}>{text}</Fragment>];
  }

  return renderTextWithExternalLinks(text, keyPrefix);
}

function findNextInlineToken(text: string, startIndex: number): InlineTokenMatch | null {
  const matches = [
    findCodeToken(text, startIndex),
    findLinkToken(text, startIndex),
    findStrongToken(text, startIndex),
    findEmphasisToken(text, startIndex),
  ].filter((candidate): candidate is InlineTokenMatch => candidate !== null);

  if (matches.length === 0) {
    return null;
  }

  matches.sort((left, right) => left.start - right.start);
  return matches[0] ?? null;
}

function findCodeToken(text: string, startIndex: number): InlineTokenMatch | null {
  let tokenStart = text.indexOf("`", startIndex);
  while (tokenStart !== -1) {
    const tokenEnd = text.indexOf("`", tokenStart + 1);
    if (tokenEnd === -1) {
      return null;
    }

    if (tokenEnd > tokenStart + 1) {
      return {
        kind: "code",
        start: tokenStart,
        end: tokenEnd + 1,
        captures: [text.slice(tokenStart + 1, tokenEnd)],
      };
    }

    tokenStart = text.indexOf("`", tokenEnd + 1);
  }

  return null;
}

function findLinkToken(text: string, startIndex: number): InlineTokenMatch | null {
  let tokenStart = text.indexOf("[", startIndex);
  while (tokenStart !== -1) {
    const labelEnd = text.indexOf("]", tokenStart + 1);
    if (labelEnd === -1 || text[labelEnd + 1] !== "(") {
      tokenStart = text.indexOf("[", tokenStart + 1);
      continue;
    }

    const urlEnd = text.indexOf(")", labelEnd + 2);
    if (urlEnd === -1) {
      tokenStart = text.indexOf("[", tokenStart + 1);
      continue;
    }

    const label = text.slice(tokenStart + 1, labelEnd).trim();
    const href = text.slice(labelEnd + 2, urlEnd).trim();
    if (!label || !/^https?:\/\//.test(href)) {
      tokenStart = text.indexOf("[", tokenStart + 1);
      continue;
    }

    return {
      kind: "link",
      start: tokenStart,
      end: urlEnd + 1,
      captures: [label, href],
    };
  }

  return null;
}

function findStrongToken(text: string, startIndex: number): InlineTokenMatch | null {
  let tokenStart = text.indexOf("**", startIndex);
  while (tokenStart !== -1) {
    const tokenEnd = text.indexOf("**", tokenStart + 2);
    if (tokenEnd === -1) {
      return null;
    }

    if (tokenEnd > tokenStart + 2) {
      return {
        kind: "strong",
        start: tokenStart,
        end: tokenEnd + 2,
        captures: [text.slice(tokenStart + 2, tokenEnd)],
      };
    }

    tokenStart = text.indexOf("**", tokenEnd + 2);
  }

  return null;
}

function findEmphasisToken(text: string, startIndex: number): InlineTokenMatch | null {
  let tokenStart = text.indexOf("*", startIndex);
  while (tokenStart !== -1) {
    if (isAsteriskAt(text, tokenStart - 1) || isAsteriskAt(text, tokenStart + 1)) {
      tokenStart = text.indexOf("*", tokenStart + 1);
      continue;
    }

    let tokenEnd = text.indexOf("*", tokenStart + 1);
    while (
      tokenEnd !== -1 &&
      (isAsteriskAt(text, tokenEnd - 1) || isAsteriskAt(text, tokenEnd + 1))
    ) {
      tokenEnd = text.indexOf("*", tokenEnd + 1);
    }

    if (tokenEnd > tokenStart + 1) {
      return {
        kind: "emphasis",
        start: tokenStart,
        end: tokenEnd + 1,
        captures: [text.slice(tokenStart + 1, tokenEnd)],
      };
    }

    tokenStart = text.indexOf("*", tokenStart + 1);
  }

  return null;
}

function isAsteriskAt(text: string, index: number) {
  return index >= 0 && index < text.length && text[index] === "*";
}
