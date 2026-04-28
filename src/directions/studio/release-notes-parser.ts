export type ReleaseNotesBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

export function parseReleaseNotes(raw: string | null): ReleaseNotesBlock[] {
  if (!raw) return [];

  const normalizedRaw = normalizeReleaseNotesMarkup(raw);
  const blocks: ReleaseNotesBlock[] = [];
  let currentList: string[] | null = null;
  let currentParagraph: string[] | null = null;

  function flushList() {
    if (currentList && currentList.length > 0) {
      blocks.push({ kind: "list", items: currentList });
    }
    currentList = null;
  }
  function flushParagraph() {
    if (currentParagraph && currentParagraph.length > 0) {
      blocks.push({
        kind: "paragraph",
        text: currentParagraph.join(" ").trim(),
      });
    }
    currentParagraph = null;
  }

  for (const line of normalizedRaw.split("\n").map((value) => value.trim())) {
    if (!line || isGeneratedNotesComment(line) || isFullChangelogLine(line)) {
      flushList();
      flushParagraph();
      continue;
    }
    if (line.startsWith("##") || line.startsWith("# ")) {
      flushList();
      flushParagraph();
      blocks.push({
        kind: "heading",
        text: line.replace(/^#+\s*/, "").trim(),
      });
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      flushParagraph();
      currentList = currentList ?? [];
      currentList.push(stripAuthorAndPrSuffix(line.slice(2).trim()));
      continue;
    }
    flushList();
    currentParagraph = currentParagraph ?? [];
    currentParagraph.push(line);
  }
  flushList();
  flushParagraph();
  return blocks;
}

function isFullChangelogLine(line: string): boolean {
  return /^\*\*Full Changelog\*\*:/i.test(line);
}

function isGeneratedNotesComment(line: string): boolean {
  return /^<!--\s*Release notes generated using configuration in \.github\/release\.yml/i.test(
    line,
  );
}

function normalizeReleaseNotesMarkup(raw: string) {
  if (!looksLikeHtml(raw)) {
    return raw;
  }

  if (typeof DOMParser === "undefined") {
    return stripHtml(raw);
  }

  const document = new DOMParser().parseFromString(raw, "text/html");
  const lines: string[] = [];
  for (const child of Array.from(document.body.children)) {
    appendHtmlReleaseNoteLines(child, lines);
  }
  return lines.length > 0 ? lines.join("\n") : stripHtml(raw);
}

function looksLikeHtml(value: string) {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function appendHtmlReleaseNoteLines(element: Element, lines: string[]) {
  const tagName = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tagName)) {
    pushLine(lines, `## ${readElementText(element)}`);
    return;
  }

  if (tagName === "li") {
    pushLine(lines, `- ${readElementText(element)}`);
    return;
  }

  if (tagName === "ul" || tagName === "ol") {
    for (const item of Array.from(element.children)) {
      appendHtmlReleaseNoteLines(item, lines);
    }
    return;
  }

  if (tagName === "p") {
    pushLine(lines, restoreMarkdownStrongMarkers(element));
    return;
  }

  if (element.children.length === 0) {
    pushLine(lines, readElementText(element));
    return;
  }

  for (const child of Array.from(element.children)) {
    appendHtmlReleaseNoteLines(child, lines);
  }
}

function restoreMarkdownStrongMarkers(element: Element) {
  const clone = element.cloneNode(true) as Element;
  for (const strong of Array.from(clone.querySelectorAll("strong, b"))) {
    strong.replaceWith(`**${readElementText(strong)}**`);
  }
  return readElementText(clone);
}

function readElementText(element: Element) {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function pushLine(lines: string[], line: string) {
  const trimmed = line.trim();
  if (trimmed) {
    lines.push(trimmed);
  }
}

function stripHtml(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function stripAuthorAndPrSuffix(item: string): string {
  return item.replace(/\s+by\s+@[\w-]+(?:\s+in\s+#\d+)?\s*$/i, "").trim();
}
