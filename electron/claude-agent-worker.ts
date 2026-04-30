import { createInterface } from "node:readline";
import { readFile, stat } from "node:fs/promises";
import process from "node:process";

import {
  getSessionMessages,
  query,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";

import {
  createClaudeEventNormalizer,
  extractPlanFromInput,
  textFromContent,
  summarizeTool,
  type ClaudeEvent,
  type TokenUsageBreakdown,
  type UserInputQuestion,
} from "./claude-agent-events.js";
import { claudeContextWindowForModel } from "../src/lib/claude-context-window.js";
import { allowClaudeTool } from "./claude-agent-permissions.js";
import { resolveClaudeCodeExecutablePath } from "./claude-code-executable.js";

type WorkerRequest<T = unknown> = {
  id: number;
  type: "open" | "send";
  payload: T;
};

type WorkerControl = {
  type: "userInputResponse";
  interactionId: string;
  answers: Record<string, string[]>;
} | {
  type: "approvalResponse";
  interactionId: string;
  approved: boolean;
} | {
  type: "interrupt";
  requestId: number;
};

type OpenPayload = {
  providerThreadId: string;
  cwd: string;
};

type SendPayload = {
  providerThreadId?: string | null;
  cwd: string;
  model: string;
  supportsThinking: boolean;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  serviceTier?: "fast" | "flex" | null;
  collaborationMode: "build" | "plan";
  approvalPolicy: "askToEdit" | "fullAccess";
  claudeBinaryPath?: string | null;
  appVersion: string;
  visibleText: string;
  text: string;
  images: ImagePayload[];
};

type ImagePayload =
  | {
      type: "image";
      url: string;
    }
  | {
      type: "localImage";
      path: string;
    };

type SimpleMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  images?: ImagePayload[] | null;
};

type ActiveQuery = {
  abortController: AbortController;
  interrupted: boolean;
  planMarkdown: string | null;
};

type ImageContentBlock = {
  block: ContentBlockParam;
  localByteSize: number;
};

type ReadMessagesResult = {
  messages: SimpleMessage[];
  fallbackUsed: boolean;
};

type SupportedImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

const pendingUserInputs = new Map<
  string,
  (answers: Record<string, string[]>) => void
>();
const pendingApprovals = new Map<string, (approved: boolean) => void>();
const activeQueries = new Map<number, ActiveQuery>();
const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_LOCAL_IMAGE_BYTES = 50 * 1024 * 1024;

function write(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeEvent(id: number, event: ClaudeEvent) {
  write({ type: "event", id, event });
}

function writeResponse(id: number, result: unknown) {
  write({ type: "response", id, ok: true, result });
}

function writeError(id: number, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  write({ type: "response", id, ok: false, error: { message } });
}

const READ_ONLY_PLAN_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
]);

const SAFE_BUILD_TOOLS = new Set([
  ...READ_ONLY_PLAN_TOOLS,
]);

function permissionMode(payload: SendPayload): PermissionMode {
  if (payload.collaborationMode === "plan") return "plan";
  if (payload.approvalPolicy === "fullAccess") return "bypassPermissions";
  return "default";
}

function optionsFor(
  payload: SendPayload,
  requestId: number,
  abortController: AbortController,
): Options {
  const mode = permissionMode(payload);
  return {
    abortController,
    cwd: payload.cwd,
    model: payload.model,
    resume: payload.providerThreadId?.trim() || undefined,
    permissionMode: mode,
    allowDangerouslySkipPermissions: mode === "bypassPermissions" ? true : undefined,
    pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath({
      explicitPath: payload.claudeBinaryPath,
    }),
    effort: payload.effort,
    thinking: payload.supportsThinking
      ? { type: "adaptive", display: "summarized" } as Options["thinking"]
      : undefined,
    systemPrompt: { type: "preset", preset: "claude_code" },
    tools: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    settings:
      payload.serviceTier === "fast"
        ? { fastMode: true, fastModePerSessionOptIn: true }
        : undefined,
    canUseTool: (toolName, input, options) =>
      approveToolUse(requestId, payload, toolName, input, options),
    includePartialMessages: true,
    promptSuggestions: false,
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: `skein/${payload.appVersion || "dev"}`,
    },
  };
}

async function approveToolUse(
  requestId: number,
  payload: SendPayload,
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string },
): Promise<PermissionResult> {
  if (toolName === "AskUserQuestion") {
    return askUserQuestion(requestId, input, options);
  }
  if (toolName === "ExitPlanMode") {
    const plan = extractPlanFromInput(input);
    if (plan) {
      emitPlanReady(requestId, activeQueries.get(requestId), options.toolUseID, plan);
    }
    return {
      behavior: "deny",
      message:
        "Skein captured this proposed plan. Stop here and wait for the user's approval or refinement.",
    };
  }
  if (READ_ONLY_PLAN_TOOLS.has(toolName)) {
    return allowClaudeTool(input);
  }
  if (payload.collaborationMode === "plan") {
    return {
      behavior: "deny",
      message:
        "Skein plan mode allows read-only tools only. Use Read, Glob, Grep, LS, WebFetch, WebSearch, TodoWrite, or ExitPlanMode instead of write or shell tools.",
    };
  }
  if (payload.approvalPolicy === "fullAccess") {
    return allowClaudeTool(input);
  }
  if (SAFE_BUILD_TOOLS.has(toolName)) {
    return allowClaudeTool(input);
  }
  return requestToolApproval(requestId, toolName, input, options);
}

async function requestToolApproval(
  requestId: number,
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string },
): Promise<PermissionResult> {
  const interactionId = `claude-approval-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeEvent(requestId, {
    kind: "approvalRequest",
    interactionId,
    itemId: options.toolUseID,
    toolName,
    title: approvalTitleForTool(toolName),
    summary: summarizeTool(toolName, input),
    command: toolName === "Bash" ? stringFromUnknown(input.command) : undefined,
    reason: "Claude wants to use this tool.",
  });
  const approved = await new Promise<boolean>((resolve) => {
    const cleanup = () => pendingApprovals.delete(interactionId);
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    pendingApprovals.set(interactionId, (value) => {
      options.signal.removeEventListener("abort", onAbort);
      cleanup();
      resolve(value);
    });
    options.signal.addEventListener("abort", onAbort, { once: true });
  });
  if (!approved) {
    return {
      behavior: "deny",
      message: `The user declined ${toolName}.`,
    };
  }
  return allowClaudeTool(input);
}

async function askUserQuestion(
  requestId: number,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string },
): Promise<PermissionResult> {
  const interactionId = `claude-input-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const questions = parseAskUserQuestions(input);
  writeEvent(requestId, {
    kind: "userInputRequest",
    interactionId,
    itemId: options.toolUseID,
    questions,
  });

  const answers = await new Promise<Record<string, string[]>>((resolve) => {
    const cleanup = () => pendingUserInputs.delete(interactionId);
    const onAbort = () => {
      cleanup();
      resolve({});
    };
    pendingUserInputs.set(interactionId, (value) => {
      options.signal.removeEventListener("abort", onAbort);
      cleanup();
      resolve(value);
    });
    options.signal.addEventListener("abort", onAbort, { once: true });
  });

  if (Object.keys(answers).length === 0) {
    return { behavior: "deny", message: "The user did not answer the question." };
  }

  return {
    behavior: "allow",
    updatedInput: {
      ...input,
      answers: flattenAnswersForClaude(questions, answers),
    },
  };
}

function parseAskUserQuestions(input: Record<string, unknown>): UserInputQuestion[] {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const usedIds = new Set<string>();
  return rawQuestions.map((value, index) => {
    const question = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const header = stringFromUnknown(question.header) || `Question ${index + 1}`;
    const questionText = stringFromUnknown(question.question);
    const id = uniqueFieldKey(
      stringFromUnknown(question.id) || questionText || header,
      `question-${index + 1}`,
      usedIds,
    );
    const options = Array.isArray(question.options)
      ? question.options.map((option) => {
          const entry = option && typeof option === "object" ? option as Record<string, unknown> : {};
          return {
            label: stringFromUnknown(entry.label),
            description: stringFromUnknown(entry.description),
          };
        }).filter((option) => option.label)
      : [];
    return {
      id,
      header,
      question: questionText,
      options,
    };
  });
}

function flattenAnswersForClaude(
  questions: UserInputQuestion[],
  answers: Record<string, string[]>,
) {
  const flattened: Record<string, string> = {};
  const usedKeys = new Set<string>();
  for (const question of questions) {
    const selected =
      answers[question.id] ??
      answers[question.question] ??
      answers[question.header] ??
      [];
    const key = uniqueFieldKey(question.id || question.question || question.header, question.id, usedKeys);
    flattened[key] = selected.filter((value) => value.trim()).join(", ");
  }
  return flattened;
}

function uniqueFieldKey(candidate: string, fallback: string, used: Set<string>) {
  const base = (candidate || fallback).trim() || fallback;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}-${index}`)) {
    index += 1;
  }
  const unique = `${base}-${index}`;
  used.add(unique);
  return unique;
}

function stringFromUnknown(value: unknown) {
  return typeof value === "string" ? value : "";
}

function imagesFromContent(content: unknown): ImagePayload[] {
  if (!Array.isArray(content)) return [];
  const images: ImagePayload[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const entry = block as Record<string, unknown>;
    if (entry.type !== "image") continue;
    const image = imagePayloadFromSource(entry.source);
    if (image) images.push(image);
  }
  return images;
}

function imagePayloadFromSource(source: unknown): ImagePayload | null {
  if (!source || typeof source !== "object") return null;
  const entry = source as Record<string, unknown>;
  if (entry.type === "url" && typeof entry.url === "string" && entry.url.trim()) {
    return { type: "image", url: entry.url };
  }
  if (
    entry.type === "base64" &&
    typeof entry.media_type === "string" &&
    entry.media_type.startsWith("image/") &&
    typeof entry.data === "string" &&
    entry.data.trim()
  ) {
    return {
      type: "image",
      url: `data:${entry.media_type};base64,${entry.data}`,
    };
  }
  return null;
}

function planFromContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const entry = block as Record<string, unknown>;
    if (entry.type !== "tool_use" || entry.name !== "ExitPlanMode") continue;
    const input = entry.input;
    if (!input || typeof input !== "object") continue;
    const plan = (input as Record<string, unknown>).plan;
    if (typeof plan === "string" && plan.trim()) return plan;
  }
  return null;
}

function messageToSimple(message: {
  type: string;
  uuid?: string;
  message?: unknown;
}): SimpleMessage | null {
  if (message.type !== "user" && message.type !== "assistant") return null;
  const payload =
    message.message && typeof message.message === "object"
      ? (message.message as { content?: unknown })
      : undefined;
  const content = payload?.content;
  const text = textFromContent(content).trim();
  const images = imagesFromContent(content);
  if (!text && images.length === 0) return null;
  return {
    id: message.uuid ?? `claude-message-${Date.now()}`,
    role: message.type,
    text,
    images: images.length > 0 ? images : undefined,
  };
}

function approvalTitleForTool(toolName: string) {
  switch (toolName) {
    case "Bash":
      return "Command approval";
    case "Edit":
    case "MultiEdit":
    case "Write":
      return "File change approval";
    default:
      return "Permission approval";
  }
}

async function readMessages(sessionId: string, cwd: string): Promise<SimpleMessage[]> {
  const messages = await getSessionMessages(sessionId, { dir: cwd });
  return messages
    .map((message) => messageToSimple(message))
    .filter((message): message is SimpleMessage => message !== null);
}

async function readMessagesWithFallback(
  sessionId: string,
  cwd: string,
  fallback: SimpleMessage[],
): Promise<ReadMessagesResult> {
  const timeoutMs = 5000;
  try {
    return await Promise.race([
      readMessages(sessionId, cwd).then((messages) => ({
        messages,
        fallbackUsed: false,
      })),
      new Promise<ReadMessagesResult>((resolve) =>
        setTimeout(() => resolve({ messages: fallback, fallbackUsed: true }), timeoutMs),
      ),
    ]);
  } catch {
    return { messages: fallback, fallbackUsed: true };
  }
}

async function promptFor(payload: SendPayload): Promise<string | AsyncIterable<SDKUserMessage>> {
  const images = payload.images ?? [];
  if (images.length === 0) return payload.text;
  const content: ContentBlockParam[] = [];
  if (payload.text.trim()) {
    content.push({
      type: "text",
      text: payload.text,
    });
  }
  let remainingLocalImageBytes = MAX_TOTAL_LOCAL_IMAGE_BYTES;
  for (const image of images) {
    const result = await imageToContentBlock(image, remainingLocalImageBytes);
    remainingLocalImageBytes -= result.localByteSize;
    content.push(result.block);
  }
  const message: SDKUserMessage = {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content,
    },
  };
  return (async function* () {
    yield message;
  })();
}

async function imageToContentBlock(
  image: ImagePayload,
  remainingLocalImageBytes: number,
): Promise<ImageContentBlock> {
  if (image.type === "image") {
    return {
      block: {
        type: "image",
        source: {
          type: "url",
          url: image.url,
        },
      },
      localByteSize: 0,
    };
  }
  const file = await stat(image.path);
  if (!file.isFile()) {
    throw new Error("Local image attachment must be a file.");
  }
  if (file.size > MAX_LOCAL_IMAGE_BYTES) {
    throw new Error("Local image attachment exceeds the 25 MiB limit.");
  }
  if (file.size > remainingLocalImageBytes) {
    throw new Error("Local image attachments exceed the 50 MiB total limit.");
  }
  const bytes = await readFile(image.path);
  const mediaType = mediaTypeForBytes(bytes);
  if (!mediaType) {
    throw new Error("Local attachment is not a supported image file.");
  }
  return {
    block: {
      type: "image",
      source: {
        type: "base64",
        data: bytes.toString("base64"),
        media_type: mediaType,
      },
    },
    localByteSize: file.size,
  };
}

function mediaTypeForBytes(bytes: Uint8Array): SupportedImageMediaType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

async function handleOpen(payload: OpenPayload) {
  const messages = await readMessages(payload.providerThreadId, payload.cwd);
  return {
    providerThreadId: payload.providerThreadId,
    messages,
  };
}

async function handleSend(requestId: number, payload: SendPayload) {
  let providerThreadId = payload.providerThreadId?.trim() || null;
  let resultError: string | null = null;
  let resultUsage: unknown = null;
  const activeQuery: ActiveQuery = {
    abortController: new AbortController(),
    interrupted: false,
    planMarkdown: null,
  };
  const itemPrefix = `claude-turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const normalizer = createClaudeEventNormalizer(itemPrefix);
  let toolSummaryOrdinal = 0;
  const streamedMessages: SimpleMessage[] = [
    {
      id: `local-user-${Date.now()}`,
      role: "user",
      text: payload.visibleText,
      images: payload.images.length > 0 ? payload.images : undefined,
    },
  ];
  activeQueries.set(requestId, activeQuery);

  let conversation: ReturnType<typeof query> | null = null;
  try {
    conversation = query({
      prompt: await promptFor(payload),
      options: optionsFor(payload, requestId, activeQuery.abortController),
    });

    for await (const message of conversation) {
      const sessionId = "session_id" in message ? message.session_id : null;
      if (typeof sessionId === "string" && sessionId) {
        providerThreadId = sessionId;
        writeEvent(requestId, { kind: "session", providerThreadId });
      }
      if (message.type === "stream_event") {
        emitClaudeEvents(
          requestId,
          activeQuery,
          normalizer.processStreamMessage(message),
        );
      }
      if (message.type === "user") {
        emitClaudeEvents(
          requestId,
          activeQuery,
          normalizer.processUserToolResults(message),
        );
      }
      if (message.type === "assistant") {
        emitClaudeEvents(
          requestId,
          activeQuery,
          normalizer.processAssistantMessage(message),
        );
        const discoveredPlan = planFromContent(message.message.content);
        if (discoveredPlan) {
          emitPlanReady(requestId, activeQuery, undefined, discoveredPlan);
        }
        const simple = messageToSimple(message);
        if (simple) streamedMessages.push(simple);
      }
      if (message.type === "tool_use_summary") {
        writeEvent(requestId, {
          kind: "reasoning",
          itemId: message.uuid ?? `${itemPrefix}-summary-${toolSummaryOrdinal++}`,
          delta: message.summary,
        });
      }
      if (message.type === "result" && message.is_error) {
        resultError =
          "errors" in message && Array.isArray(message.errors)
            ? message.errors.join("\n")
            : message.stop_reason ?? "Claude failed to complete the turn.";
      }
      if (message.type === "result") {
        resultUsage = "usage" in message ? message.usage : null;
      }
    }
  } catch (error) {
    if (activeQuery.interrupted) {
      throw new Error("Claude turn was interrupted.");
    }
    throw error;
  } finally {
    activeQueries.delete(requestId);
    if (activeQuery.interrupted) {
      conversation?.close();
    }
  }

  if (resultError) {
    throw new Error(resultError);
  }
  if (!providerThreadId) {
    throw new Error("Claude did not return a session id.");
  }

  const tokenUsage = await tokenUsageEventFor(
    conversation,
    payload.model,
    resultUsage,
  );
  if (tokenUsage) {
    writeEvent(requestId, tokenUsage);
  }

  const messageResult = await readMessagesWithFallback(
    providerThreadId,
    payload.cwd,
    streamedMessages,
  );
  return {
    providerThreadId,
    messages: messageResult.messages,
    messagesAuthoritative: !messageResult.fallbackUsed,
    planMarkdown: activeQuery.planMarkdown,
  };
}

function emitPlanReady(
  requestId: number,
  activeQuery: ActiveQuery | undefined,
  itemId: string | undefined,
  markdown: string,
) {
  const plan = markdown.trim();
  if (!plan || activeQuery?.planMarkdown === plan) {
    return;
  }
  if (activeQuery) {
    activeQuery.planMarkdown = plan;
  }
  writeEvent(requestId, { kind: "planReady", itemId, markdown: plan });
}

function emitClaudeEvents(
  requestId: number,
  activeQuery: ActiveQuery,
  events: ClaudeEvent[],
) {
  for (const event of events) {
    if (event.kind === "planReady") {
      emitPlanReady(requestId, activeQuery, event.itemId, event.markdown);
      continue;
    }
    writeEvent(requestId, event);
  }
}

async function tokenUsageEventFor(
  conversation: { getContextUsage?: () => Promise<unknown> },
  model: string,
  resultUsage: unknown,
): Promise<ClaudeEvent | null> {
  const contextUsage =
    typeof conversation.getContextUsage === "function"
      ? await conversation.getContextUsage().catch(() => null)
      : null;
  const contextBreakdown = tokenUsageBreakdownFromContextUsage(contextUsage);
  const totalBreakdown =
    tokenUsageBreakdownFromUsage(resultUsage) ?? contextBreakdown;
  const lastBreakdown = contextBreakdown ?? totalBreakdown;
  const modelContextWindow = claudeContextWindowForModel(model);

  if (!totalBreakdown || !lastBreakdown) {
    return null;
  }

  return {
    kind: "tokenUsage",
    total: totalBreakdown,
    last: lastBreakdown,
    modelContextWindow,
  };
}

function tokenUsageBreakdownFromContextUsage(
  value: unknown,
): TokenUsageBreakdown | null {
  const totalTokens = numberField(value, "totalTokens", "total_tokens");
  if (!totalTokens || totalTokens <= 0) return null;
  return {
    totalTokens,
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function tokenUsageBreakdownFromUsage(value: unknown): TokenUsageBreakdown | null {
  const inputTokens = numberField(value, "input_tokens", "inputTokens") ?? 0;
  const cacheReadInputTokens =
    numberField(value, "cache_read_input_tokens", "cacheReadInputTokens") ?? 0;
  const cacheCreationInputTokens =
    numberField(
      value,
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
    ) ?? 0;
  const outputTokens = numberField(value, "output_tokens", "outputTokens") ?? 0;
  const totalTokens =
    inputTokens + cacheReadInputTokens + cacheCreationInputTokens + outputTokens;
  if (totalTokens <= 0) return null;
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens: cacheReadInputTokens + cacheCreationInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
  };
}

function numberField(value: unknown, ...keys: string[]): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
  }
  return null;
}

async function handleRequest(request: WorkerRequest) {
  switch (request.type) {
    case "open":
      return handleOpen(request.payload as OpenPayload);
    case "send":
      return handleSend(request.id, request.payload as SendPayload);
    default:
      throw new Error(`Unsupported Claude worker command: ${request.type}`);
  }
}

function handleControl(control: WorkerControl) {
  if (control.type === "interrupt") {
    const active = activeQueries.get(control.requestId);
    if (!active) return;
    active.interrupted = true;
    active.abortController.abort();
    return;
  }
  if (control.type === "userInputResponse") {
    const resolve = pendingUserInputs.get(control.interactionId);
    if (!resolve) return;
    resolve(control.answers ?? {});
    return;
  }
  const resolve = pendingApprovals.get(control.interactionId);
  if (!resolve) return;
  resolve(control.approved);
}

async function main() {
  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: WorkerRequest | WorkerControl;
    try {
      message = JSON.parse(trimmed) as WorkerRequest | WorkerControl;
    } catch (error) {
      writeError(0, error);
      continue;
    }
    if (
      message.type === "userInputResponse" ||
      message.type === "approvalResponse" ||
      message.type === "interrupt"
    ) {
      handleControl(message);
      continue;
    }
    void handleRequest(message)
      .then((result) => writeResponse(message.id, result))
      .catch((error) => writeError(message.id, error));
  }
}

void main();
