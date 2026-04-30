import type {
  ComposerMentionBindingInput,
  ComposerPromptArgumentMode,
  ComposerPromptOption,
  ProviderKind,
  ThreadComposerCatalog,
} from "../../../lib/types";

export const PROMPT_PREFIX = "/prompts:";
const TOKEN_BOUNDARY = /[\s([{'"`,.;:!?)}\]]/;
const TOKEN_STOP = /[\s)\]},"'`;]/;
const SPACE_APPEND_STOP = /[\s,.;:!?)}\]>"'`]/;
const UNKNOWN_COMMAND_TOKEN_SIGNAL = /[-_.:]/;
const AMBIGUOUS_SLASH_PATH_ROOTS = new Set([
  "applications",
  "bin",
  "dev",
  "etc",
  "home",
  "library",
  "mnt",
  "opt",
  "private",
  "proc",
  "run",
  "sbin",
  "sys",
  "tmp",
  "users",
  "usr",
  "var",
  "volumes",
  "workspace",
]);

function formatSlugLabel(slug: string): string {
  return slug
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export type ActiveComposerToken =
  | { kind: "prompt"; start: number; end: number; raw: string; query: string }
  | { kind: "mention"; start: number; end: number; raw: string; query: string }
  | { kind: "file"; start: number; end: number; raw: string; query: string };

export type ComposerAutocompleteItem = {
  id: string;
  group: "Commands" | "Prompts" | "Skills" | "Apps" | "Files";
  label: string;
  description?: string;
  hint?: string;
  insertText: string;
  cursorOffset?: number;
  appendSpace?: boolean;
  mentionBinding?: ComposerMentionBindingInput;
};

export type ComposerMirrorPart = {
  text: string;
  tone: "base" | "name" | "value";
};

export type ComposerMirrorSegment =
  | { kind: "text"; text: string }
  | {
      kind: "prompt";
      text: string;
      parts: ComposerMirrorPart[];
      start: number;
      end: number;
    }
  | { kind: "skill"; text: string; start: number; end: number }
  | { kind: "app"; text: string; start: number; end: number }
  | { kind: "file"; text: string; start: number; end: number };

export type DecorateComposerTextOptions = {
  decorateAllProviderTokens?: boolean;
  decorateFileTokens?: boolean;
  decorateUnknownTokens?: boolean;
  mentionBindings?: ComposerMentionBindingInput[];
};

type DecoratedToken =
  | ({ kind: "prompt"; text: string; parts: ComposerMirrorPart[] } & {
      start: number;
      end: number;
    })
  | ({ kind: "skill"; text: string } & { start: number; end: number })
  | ({ kind: "app"; text: string } & { start: number; end: number })
  | ({ kind: "file"; text: string } & { start: number; end: number });

type PromptInvocation = {
  start: number;
  end: number;
  raw: string;
  name: string;
};

export function connectorMentionSlug(name: string) {
  let normalized = "";
  for (const character of name) {
    if (/[A-Za-z0-9]/.test(character)) {
      normalized += character.toLowerCase();
    } else {
      normalized += "-";
    }
  }
  const trimmed = normalized.replace(/^-+|-+$/g, "");
  return trimmed || "app";
}

export function buildPromptInsertText(prompt: ComposerPromptOption) {
  const base = `${PROMPT_PREFIX}${prompt.name}`;
  if (prompt.argumentMode === "none") {
    return {
      text: `${base}()`,
      appendSpace: true,
    };
  }

  const values =
    prompt.argumentMode === "named"
      ? prompt.argumentNames.map((name) => `${name}=""`)
      : Array.from({ length: Math.max(prompt.positionalCount, 1) }, () => '""');
  const text = `${base}(${values.join(", ")})`;
  const firstPlaceholder = text.indexOf('""');
  return {
    text,
    cursorOffset: firstPlaceholder >= 0 ? firstPlaceholder + 1 : text.length,
    appendSpace: false,
  };
}

export function findActiveComposerToken(
  text: string,
  selectionStart: number | null,
  selectionEnd: number | null,
): ActiveComposerToken | null {
  if (
    selectionStart === null ||
    selectionEnd === null ||
    selectionStart !== selectionEnd
  ) {
    return null;
  }

  let start = selectionStart;
  while (start > 0) {
    const candidate = text[start - 1] ?? "";
    if (TOKEN_BOUNDARY.test(candidate)) {
      break;
    }
    start -= 1;
  }

  let end = selectionStart;
  while (end < text.length) {
    const candidate = text[end] ?? "";
    if (TOKEN_STOP.test(candidate)) {
      break;
    }
    end += 1;
  }

  const raw = text.slice(start, end);
  if (raw.length === 0) {
    return null;
  }
  if (raw.startsWith("/") && !raw.includes("(")) {
    return {
      kind: "prompt",
      start,
      end,
      raw,
      query: raw.slice(1),
    };
  }
  if (raw.startsWith("$")) {
    return {
      kind: "mention",
      start,
      end,
      raw,
      query: raw.slice(1),
    };
  }
  if (raw.startsWith("@")) {
    return {
      kind: "file",
      start,
      end,
      raw,
      query: raw.slice(1),
    };
  }
  return null;
}

export function buildAutocompleteItems(
  token: ActiveComposerToken | null,
  catalog: ThreadComposerCatalog | null,
  filePaths: string[],
  provider: ProviderKind = "codex",
): ComposerAutocompleteItem[] {
  if (!token) {
    return [];
  }

  if (token.kind === "prompt") {
    if (provider === "claude") {
      return buildClaudeSlashAutocompleteItems(token, catalog);
    }

    const query = token.query.toLowerCase();
    const prompts = catalog?.prompts ?? [];
    return prompts
      .filter((prompt) => {
        const label = `prompts:${prompt.name}`.toLowerCase();
        return (
          label.startsWith(query) ||
          prompt.name.toLowerCase().startsWith(query) ||
          prompt.name.toLowerCase().includes(query)
        );
      })
      .map((prompt) => {
        const insert = buildPromptInsertText(prompt);
        return {
          id: `prompt:${prompt.name}`,
          group: "Prompts",
          label: `prompts:${prompt.name}`,
          description: prompt.description ?? undefined,
          hint: prompt.argumentHint ?? undefined,
          insertText: insert.text,
          cursorOffset: insert.cursorOffset,
          appendSpace: insert.appendSpace,
        };
      });
  }

  if (token.kind === "mention") {
    if (provider === "claude") {
      return buildClaudeMentionAutocompleteItems(token, catalog);
    }

    const query = token.query.toLowerCase();
    const skills = (catalog?.skills ?? [])
      .filter((skill) => {
        const name = skill.name.toLowerCase();
        return name.startsWith(query) || name.includes(query);
      })
      .map<ComposerAutocompleteItem>((skill) => ({
        id: `skill:${skill.name}`,
        group: "Skills",
        label: formatSlugLabel(skill.name),
        description: skill.description,
        insertText: `$${skill.name}`,
        appendSpace: true,
        mentionBinding: {
          mention: skill.name,
          kind: "skill",
          path: skill.path,
        },
      }));
    const apps = (catalog?.apps ?? [])
      .filter((app) => {
        const slug = app.slug.toLowerCase();
        const name = app.name.toLowerCase();
        return (
          slug.startsWith(query) ||
          name.startsWith(query) ||
          slug.includes(query) ||
          name.includes(query)
        );
      })
      .map<ComposerAutocompleteItem>((app) => ({
        id: `app:${app.id}`,
        group: "Apps",
        label: app.name || formatSlugLabel(app.slug),
        description: app.description ?? app.name,
        insertText: `$${app.slug}`,
        appendSpace: true,
        mentionBinding: {
          mention: app.slug,
          kind: "app",
          path: app.path,
        },
      }));
    return [...skills, ...apps];
  }

  return filePaths.map((path) => ({
    id: `file:${path}`,
    group: "Files",
    label: path,
    insertText: `@${path}`,
    appendSpace: true,
  }));
}

function buildClaudeSlashAutocompleteItems(
  token: ActiveComposerToken,
  catalog: ThreadComposerCatalog | null,
) {
  const query = token.query.toLowerCase();
  return (catalog?.prompts ?? [])
    .filter((command) => matchesClaudeCommandQuery(command.name, query))
    .map<ComposerAutocompleteItem>((command) => ({
      id: `claude-command:${command.name}`,
      group: "Commands",
      label: `/${command.name}`,
      description: command.description ?? undefined,
      hint: command.argumentHint ?? undefined,
      insertText: `/${command.name}`,
      appendSpace: true,
    }));
}

function buildClaudeMentionAutocompleteItems(
  token: ActiveComposerToken,
  catalog: ThreadComposerCatalog | null,
) {
  const query = token.query.toLowerCase();
  return (catalog?.skills ?? [])
    .filter((skill) => matchesClaudeCommandQuery(skill.name, query))
    .map<ComposerAutocompleteItem>((skill) => ({
      id: `claude-skill-mention:${skill.name}`,
      group: "Skills",
      label: formatSlugLabel(skill.name),
      description: skill.description,
      insertText: `$${skill.name}`,
      appendSpace: true,
    }));
}

function matchesClaudeCommandQuery(name: string, query: string) {
  const normalized = name.toLowerCase();
  return normalized.startsWith(query) || normalized.includes(query);
}

export function replaceComposerToken(
  text: string,
  token: ActiveComposerToken,
  item: ComposerAutocompleteItem,
) {
  const suffix = text.slice(token.end);
  const cursorOffset = item.cursorOffset ?? item.insertText.length;
  const shouldAppendTrailingSpace =
    item.appendSpace === true && shouldAppendSpace(suffix);
  const insertedText = shouldAppendTrailingSpace
    ? `${item.insertText} `
    : item.insertText;
  const nextText = `${text.slice(0, token.start)}${insertedText}${suffix}`;
  const baseCursor = token.start + cursorOffset;
  const cursor =
    shouldAppendTrailingSpace && cursorOffset >= item.insertText.length
      ? baseCursor + 1
      : baseCursor;
  return { text: nextText, cursor };
}

function shouldAppendSpace(suffix: string) {
  if (suffix.length === 0) {
    return true;
  }
  const nextCharacter = suffix[0] ?? "";
  return !SPACE_APPEND_STOP.test(nextCharacter);
}

export function decorateComposerText(
  text: string,
  catalog: ThreadComposerCatalog | null,
  provider: ProviderKind = "codex",
  options: DecorateComposerTextOptions = {},
): ComposerMirrorSegment[] {
  if (!text) {
    return [];
  }

  const decorateAllProviderTokens = options.decorateAllProviderTokens === true;
  const decorateFileTokens = options.decorateFileTokens !== false;
  const decorateUnknownTokens = options.decorateUnknownTokens === true;
  const mentionBindingMap = new Map(
    (options.mentionBindings ?? []).map((binding) => [
      binding.mention.toLowerCase(),
      binding.kind,
    ]),
  );
  const promptMap = new Map(
    (catalog?.prompts ?? []).map((prompt) => [prompt.name, prompt]),
  );
  const skillMap = new Map(
    (catalog?.skills ?? []).map((skill) => [skill.name.toLowerCase(), skill]),
  );
  const appMap = new Map(
    (catalog?.apps ?? []).map((app) => [app.slug.toLowerCase(), app]),
  );
  const promptInvocations =
    provider === "claude" && !decorateAllProviderTokens
      ? []
      : parsePromptInvocations(text);
  const occupied = promptInvocations.map((invocation) => ({
    start: invocation.start,
    end: invocation.end,
  }));
  const promptTokens: DecoratedToken[] = promptInvocations
    .filter(
      (invocation) =>
        decorateUnknownTokens || promptMap.has(invocation.name),
    )
    .map((invocation) => ({
      kind: "prompt",
      text: invocation.raw,
      parts: buildPromptMirrorParts(invocation.raw),
      start: invocation.start,
      end: invocation.end,
    }));
  const mentionTokens: DecoratedToken[] = [];
  if (provider === "claude" || decorateAllProviderTokens) {
    for (const token of collectSpecialTokens(text, "/", occupied)) {
      const resolved = resolveSlashCommandToken(
        token.text,
        promptMap,
        decorateUnknownTokens,
        decorateAllProviderTokens,
        provider,
      );
      if (resolved) {
        mentionTokens.push({
          kind: "prompt",
          text: resolved,
          parts: [{ text: resolved, tone: "base" }],
          start: token.start,
          end: token.start + resolved.length,
        });
      }
    }
  }
  for (const token of collectSpecialTokens(text, "$", occupied)) {
    const resolved = resolveDollarMentionToken(
      token.text,
      mentionBindingMap,
      skillMap,
      appMap,
      decorateUnknownTokens,
    );
    if (resolved) {
      mentionTokens.push({
        kind: resolved.kind,
        text: resolved.text,
        start: token.start,
        end: token.start + resolved.text.length,
      });
    }
  }
  const fileTokens: DecoratedToken[] = decorateFileTokens
    ? collectSpecialTokens(text, "@", occupied).map((token) => ({
        kind: "file",
        text: token.text,
        start: token.start,
        end: token.end,
      }))
    : [];
  const tokens: DecoratedToken[] = [
    ...promptTokens,
    ...mentionTokens,
    ...fileTokens,
  ].sort((left, right) => left.start - right.start);

  const segments: ComposerMirrorSegment[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, token.start) });
    }
    segments.push(token);
    cursor = token.end;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}

export function findComposerTokenDeletionRange(
  text: string,
  cursor: number,
  catalog: ThreadComposerCatalog | null,
  provider: ProviderKind = "codex",
) {
  if (cursor <= 0 || cursor > text.length) {
    return null;
  }

  const segments = decorateComposerText(text, catalog, provider);
  for (const segment of segments) {
    if (segment.kind === "text") {
      continue;
    }
    if (cursor === segment.end) {
      return { start: segment.start, end: segment.end };
    }
    if (text[cursor - 1] === " " && cursor - 1 === segment.end) {
      return { start: segment.start, end: cursor };
    }
  }

  return null;
}

function parsePromptInvocations(text: string): PromptInvocation[] {
  const invocations: PromptInvocation[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(PROMPT_PREFIX, cursor);
    if (start === -1) {
      break;
    }
    const previous = start > 0 ? text[start - 1] : "";
    if (previous && /[A-Za-z0-9:_/-]/.test(previous)) {
      cursor = start + 1;
      continue;
    }
    let index = start + PROMPT_PREFIX.length;
    while (index < text.length && /[A-Za-z0-9._-]/.test(text[index] ?? "")) {
      index += 1;
    }
    const name = text.slice(start + PROMPT_PREFIX.length, index);
    if (!name || text[index] !== "(") {
      cursor = start + 1;
      continue;
    }
    const end = findClosingParen(text, index);
    if (end === -1) {
      cursor = start + 1;
      continue;
    }
    invocations.push({
      start,
      end: end + 1,
      raw: text.slice(start, end + 1),
      name,
    });
    cursor = end + 1;
  }
  return invocations;
}

function findClosingParen(text: string, openParenIndex: number) {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = openParenIndex + 1; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ")") {
      return index;
    }
  }
  return -1;
}

function collectSpecialTokens(
  text: string,
  trigger: "$" | "@" | "/",
  occupied: Array<{ start: number; end: number }>,
) {
  const tokens: Array<{ start: number; end: number; text: string }> = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(trigger, index);
    if (start === -1) {
      break;
    }
    if (occupied.some((range) => start >= range.start && start < range.end)) {
      index = start + 1;
      continue;
    }
    const previous = start > 0 ? (text[start - 1] ?? "") : "";
    if (previous && !TOKEN_BOUNDARY.test(previous)) {
      index = start + 1;
      continue;
    }
    let end = start + 1;
    while (end < text.length) {
      const character = text[end] ?? "";
      if (TOKEN_STOP.test(character)) {
        break;
      }
      end += 1;
    }
    if (end > start + 1) {
      tokens.push({
        start,
        end,
        text: text.slice(start, end),
      });
    }
    index = end;
  }
  return tokens;
}

function resolveSlashCommandToken(
  text: string,
  promptMap: Map<string, unknown>,
  decorateUnknownTokens: boolean,
  decorateAllProviderTokens: boolean,
  provider: ProviderKind,
) {
  if (promptMap.has(text.slice(1).toLowerCase())) {
    return text;
  }

  const trimmed = trimTrailingTokenPunctuation(text);
  if (
    shouldDecorateSlashCommandToken(
      trimmed,
      promptMap,
      decorateUnknownTokens,
      decorateAllProviderTokens,
      provider,
    )
  ) {
    return trimmed;
  }
  return null;
}

function shouldDecorateSlashCommandToken(
  text: string,
  promptMap: Map<string, unknown>,
  decorateUnknownTokens: boolean,
  decorateAllProviderTokens: boolean,
  provider: ProviderKind,
) {
  const normalized = text.slice(1).toLowerCase();
  return (
    promptMap.has(normalized) ||
    (decorateUnknownTokens &&
      isSlashCommandToken(text, provider, decorateAllProviderTokens))
  );
}

function resolveDollarMentionToken(
  text: string,
  mentionBindingMap: Map<string, "skill" | "app">,
  skillMap: Map<string, unknown>,
  appMap: Map<string, unknown>,
  decorateUnknownTokens: boolean,
): { kind: "skill" | "app"; text: string } | null {
  const exactKind = lookupDollarMentionKind(
    text,
    mentionBindingMap,
    skillMap,
    appMap,
  );
  if (exactKind) {
    return { kind: exactKind, text };
  }

  const trimmed = trimTrailingTokenPunctuation(text);
  if (trimmed !== text) {
    const trimmedKind = lookupDollarMentionKind(
      trimmed,
      mentionBindingMap,
      skillMap,
      appMap,
    );
    if (trimmedKind) {
      return { kind: trimmedKind, text: trimmed };
    }
  }

  if (decorateUnknownTokens && isDollarMentionToken(trimmed)) {
    return { kind: "skill", text: trimmed };
  }
  return null;
}

function lookupDollarMentionKind(
  text: string,
  mentionBindingMap: Map<string, "skill" | "app">,
  skillMap: Map<string, unknown>,
  appMap: Map<string, unknown>,
) {
  const normalized = text.slice(1).toLowerCase();
  const explicitKind = mentionBindingMap.get(normalized);
  if (explicitKind) {
    return explicitKind;
  }
  if (skillMap.has(normalized)) {
    return "skill";
  }
  if (appMap.has(normalized)) {
    return "app";
  }
  return null;
}

function trimTrailingTokenPunctuation(text: string) {
  return text.replace(/[.!?:]+$/u, "");
}

function isSlashCommandToken(
  text: string,
  provider: ProviderKind,
  decorateAllProviderTokens: boolean,
) {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._:-]*)$/.exec(text);
  if (!match) {
    return false;
  }
  if (UNKNOWN_COMMAND_TOKEN_SIGNAL.test(match[1])) {
    return true;
  }
  const normalized = match[1].toLowerCase();
  return (
    (provider === "claude" || decorateAllProviderTokens) &&
    /^[a-z][a-z0-9]*$/.test(match[1]) &&
    !AMBIGUOUS_SLASH_PATH_ROOTS.has(normalized)
  );
}

function isDollarMentionToken(text: string) {
  const match = /^\$([a-z][a-z0-9._:-]*)$/.exec(text);
  return Boolean(match && UNKNOWN_COMMAND_TOKEN_SIGNAL.test(match[1]));
}

function buildPromptMirrorParts(raw: string): ComposerMirrorPart[] {
  const openIndex = raw.indexOf("(");
  if (openIndex === -1) {
    return [{ text: raw, tone: "base" }];
  }

  const parts: ComposerMirrorPart[] = [
    { text: raw.slice(0, openIndex), tone: "base" },
  ];
  let index = openIndex;

  while (index < raw.length) {
    const character = raw[index] ?? "";
    if (character === '"' || character === "'") {
      const end = findClosingQuote(raw, index);
      parts.push({
        text: raw.slice(index, end + 1),
        tone: "value",
      });
      index = end + 1;
      continue;
    }

    if (/[A-Z]/.test(character) && isArgumentNameStart(raw, index)) {
      let end = index + 1;
      while (end < raw.length && /[A-Z0-9_]/.test(raw[end] ?? "")) {
        end += 1;
      }
      parts.push({
        text: raw.slice(index, end),
        tone: "name",
      });
      index = end;
      continue;
    }

    parts.push({ text: character, tone: "base" });
    index += 1;
  }

  return parts;
}

function isArgumentNameStart(raw: string, index: number) {
  const previous = index > 0 ? (raw[index - 1] ?? "") : "";
  const nextEquals = raw.slice(index).match(/^[A-Z][A-Z0-9_]*(?=\s*=)/);
  return (!previous || /[(,\s]/.test(previous)) && Boolean(nextEquals);
}

function findClosingQuote(text: string, start: number) {
  const quote = text[start] ?? '"';
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) {
      return index;
    }
  }
  return text.length - 1;
}

export function labelForPromptMode(mode: ComposerPromptArgumentMode) {
  if (mode === "named") return "Named";
  if (mode === "positional") return "Positional";
  return "Prompt";
}
