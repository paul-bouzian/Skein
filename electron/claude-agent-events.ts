export type ClaudeTaskStepStatus = "pending" | "inProgress" | "completed";

export type ClaudeTaskStep = {
  content: string;
  status: ClaudeTaskStepStatus;
};

export type ClaudeEvent =
  | {
      kind: "session";
      providerThreadId: string;
    }
  | {
      kind: "tokenUsage";
      total: TokenUsageBreakdown;
      last: TokenUsageBreakdown;
      modelContextWindow?: number | null;
    }
  | {
      kind: "assistantDelta";
      itemId: string;
      delta: string;
    }
  | {
      kind: "toolStarted";
      itemId: string;
      toolName: string;
      title: string;
      summary?: string;
    }
  | {
      kind: "toolUpdated";
      itemId: string;
      toolName: string;
      title: string;
      summary?: string;
    }
  | {
      kind: "toolOutput";
      itemId: string;
      delta: string;
      isError?: boolean;
    }
  | {
      kind: "toolCompleted";
      itemId: string;
      isError?: boolean;
    }
  | {
      kind: "reasoning";
      itemId: string;
      delta: string;
    }
  | {
      kind: "planReady";
      itemId?: string;
      markdown: string;
    }
  | {
      kind: "taskPlanUpdated";
      itemId: string;
      steps: ClaudeTaskStep[];
    }
  | {
      kind: "subagentStarted";
      itemId: string;
      description: string;
      subagentType: string;
    }
  | {
      kind: "subagentCompleted";
      itemId: string;
      isError?: boolean;
    }
  | {
      kind: "userInputRequest";
      interactionId: string;
      itemId: string;
      questions: UserInputQuestion[];
    }
  | {
      kind: "approvalRequest";
      interactionId: string;
      itemId: string;
      toolName: string;
      title: string;
      summary?: string;
      command?: string;
      reason?: string;
    };

export type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
};

export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type InFlightTool = {
  itemId: string;
  toolName: string;
  title: string;
  summary?: string;
  partialInputJson: string;
  lastInputFingerprint?: string;
};

export type ClaudeEventNormalizer = {
  processAssistantMessage(message: { uuid?: string; message?: unknown }): ClaudeEvent[];
  processStreamMessage(message: { event?: unknown }): ClaudeEvent[];
  processUserToolResults(message: { message?: unknown }): ClaudeEvent[];
};

type NormalizerState = {
  messageOrdinal: number;
  assistantFallbackOrdinal: number;
  sawMessageStart: boolean;
  toolsByIndex: Map<number, InFlightTool>;
  toolsById: Map<string, InFlightTool>;
  streamedReasoningIndexes: Set<number | null>;
  emittedToolIds: Set<string>;
  todoWriteToolUseIds: Set<string>;
  subagentToolUseIds: Set<string>;
  todoWriteFingerprints: Map<string, string>;
};

export function createClaudeEventNormalizer(itemPrefix: string): ClaudeEventNormalizer {
  const state: NormalizerState = {
    messageOrdinal: 0,
    assistantFallbackOrdinal: 0,
    sawMessageStart: false,
    toolsByIndex: new Map(),
    toolsById: new Map(),
    streamedReasoningIndexes: new Set(),
    emittedToolIds: new Set(),
    todoWriteToolUseIds: new Set(),
    subagentToolUseIds: new Set(),
    todoWriteFingerprints: new Map(),
  };

  return {
    processAssistantMessage: (message) => processAssistantMessage(itemPrefix, state, message),
    processStreamMessage: (message) => processStreamMessage(itemPrefix, state, message),
    processUserToolResults: (message) => processUserToolResults(state, message),
  };
}

function processStreamMessage(
  itemPrefix: string,
  state: NormalizerState,
  message: { event?: unknown },
): ClaudeEvent[] {
  const event = asRecord(message.event);
  if (!event) return [];
  if (event.type === "message_start") {
    if (state.sawMessageStart) {
      state.messageOrdinal += 1;
    }
    state.sawMessageStart = true;
    state.toolsByIndex.clear();
    state.streamedReasoningIndexes.clear();
    return [];
  }

  const index = typeof event.index === "number" ? event.index : null;
  if (event.type === "content_block_start") {
    const block = asRecord(event.content_block);
    if (!block) return [];
    return startContentBlock(itemPrefix, state, index, block);
  }

  if (event.type === "content_block_delta") {
    const delta = asRecord(event.delta);
    if (!delta) return [];
    return deltaContentBlock(itemPrefix, state, index, delta);
  }

  return [];
}

function startContentBlock(
  itemPrefix: string,
  state: NormalizerState,
  index: number | null,
  block: Record<string, unknown>,
): ClaudeEvent[] {
  if (block.type === "text") {
    const text = stringFromUnknown(block.text);
    return text
      ? [{
          kind: "assistantDelta",
          itemId: assistantItemId(itemPrefix, state, index),
          delta: text,
        }]
      : [];
  }

  if (isToolResultBlock(block)) {
    return completeToolFromResultBlock(state, block);
  }

  if (!isToolUseBlock(block)) {
    return [];
  }

  const toolName = normalizeToolName(block);
  const input = asRecord(block.input) ?? {};
  const itemId = stringFromUnknown(block.id) || toolItemId(itemPrefix, state, index);
  if (toolName === "ExitPlanMode") {
    state.emittedToolIds.add(itemId);
    const plan = extractPlanFromInput(input);
    return plan ? [{ kind: "planReady", itemId, markdown: plan }] : [];
  }
  if (toolName === "TodoWrite") {
    state.emittedToolIds.add(itemId);
    state.todoWriteToolUseIds.add(itemId);
    const tool = createInFlightTool(itemId, toolName, input);
    if (index !== null) state.toolsByIndex.set(index, tool);
    state.toolsById.set(itemId, tool);
    return emitTodoWritePlanIfChanged(state, itemId, input);
  }
  if (isSubagentToolName(toolName)) {
    state.emittedToolIds.add(itemId);
    state.subagentToolUseIds.add(itemId);
    const tool = createInFlightTool(itemId, toolName, input);
    if (index !== null) state.toolsByIndex.set(index, tool);
    state.toolsById.set(itemId, tool);
    return [buildSubagentStartedEvent(itemId, input)];
  }

  const tool = createInFlightTool(itemId, toolName, input);
  if (index !== null) state.toolsByIndex.set(index, tool);
  state.toolsById.set(itemId, tool);
  state.emittedToolIds.add(itemId);
  return [{
    kind: "toolStarted",
    itemId,
    toolName,
    title: tool.title,
    summary: tool.summary,
  }];
}

function deltaContentBlock(
  itemPrefix: string,
  state: NormalizerState,
  index: number | null,
  delta: Record<string, unknown>,
): ClaudeEvent[] {
  if (delta.type === "text_delta") {
    const text = stringFromUnknown(delta.text);
    return text
      ? [{
          kind: "assistantDelta",
          itemId: assistantItemId(itemPrefix, state, index),
          delta: text,
        }]
      : [];
  }

  if (delta.type === "thinking_delta") {
    const thinking = stringFromUnknown(delta.thinking);
    if (!thinking) return [];
    state.streamedReasoningIndexes.add(index);
    return [{
      kind: "reasoning",
      itemId: reasoningItemId(itemPrefix, state, index),
      delta: thinking,
    }];
  }

  if (delta.type !== "input_json_delta" || index === null) return [];
  const tool = state.toolsByIndex.get(index);
  const partial = stringFromUnknown(delta.partial_json);
  if (!tool || !partial) return [];
  tool.partialInputJson += partial;
  const parsed = parsePartialJson(tool.partialInputJson);
  if (!parsed) return [];
  const fingerprint = compactJson(parsed);
  if (!fingerprint || fingerprint === tool.lastInputFingerprint) return [];
  tool.lastInputFingerprint = fingerprint;
  if (state.todoWriteToolUseIds.has(tool.itemId)) {
    return emitTodoWritePlanIfChanged(state, tool.itemId, parsed);
  }
  if (state.subagentToolUseIds.has(tool.itemId)) {
    return [buildSubagentStartedEvent(tool.itemId, parsed)];
  }
  tool.summary = summarizeTool(tool.toolName, parsed);
  return [{
    kind: "toolUpdated",
    itemId: tool.itemId,
    toolName: tool.toolName,
    title: tool.title,
    summary: tool.summary,
  }];
}

function processAssistantMessage(
  itemPrefix: string,
  state: NormalizerState,
  message: { uuid?: string; message?: unknown },
): ClaudeEvent[] {
  const content = messageContent(message);
  if (!Array.isArray(content)) return [];
  const messageKey =
    message.uuid ?? `${itemPrefix}-assistant-${state.assistantFallbackOrdinal++}`;
  const events: ClaudeEvent[] = [];
  content.forEach((entry, index) => {
    const block = asRecord(entry);
    if (!block) return;
    if (block.type === "thinking" && !state.streamedReasoningIndexes.has(index)) {
      const thinking = stringFromUnknown(block.thinking);
      if (thinking) {
        events.push({
          kind: "reasoning",
          itemId: `${messageKey}-reasoning-${index}`,
          delta: thinking,
        });
      }
      return;
    }
    if (!isToolUseBlock(block)) return;
    const explicitItemId = stringFromUnknown(block.id);
    const streamedFallbackToolId = toolItemId(itemPrefix, state, index);
    if (explicitItemId && state.emittedToolIds.has(streamedFallbackToolId)) {
      const streamedTool = state.toolsById.get(streamedFallbackToolId);
      if (streamedTool) {
        state.toolsById.set(explicitItemId, streamedTool);
        state.emittedToolIds.add(explicitItemId);
        return;
      }
    }
    const itemId = explicitItemId
      || (state.emittedToolIds.has(streamedFallbackToolId)
        ? streamedFallbackToolId
        : `${messageKey}-tool-${index}`);
    if (state.emittedToolIds.has(itemId)) return;
    const toolName = normalizeToolName(block);
    if (toolName === "ExitPlanMode") {
      state.emittedToolIds.add(itemId);
      return;
    }
    const input = asRecord(block.input) ?? {};
    if (toolName === "TodoWrite") {
      state.emittedToolIds.add(itemId);
      state.todoWriteToolUseIds.add(itemId);
      const tool = createInFlightTool(itemId, toolName, input);
      state.toolsById.set(itemId, tool);
      const todoEvents = emitTodoWritePlanIfChanged(state, itemId, input);
      for (const todoEvent of todoEvents) events.push(todoEvent);
      return;
    }
    if (isSubagentToolName(toolName)) {
      state.emittedToolIds.add(itemId);
      state.subagentToolUseIds.add(itemId);
      const tool = createInFlightTool(itemId, toolName, input);
      state.toolsById.set(itemId, tool);
      events.push(buildSubagentStartedEvent(itemId, input));
      return;
    }
    const tool = createInFlightTool(itemId, toolName, input);
    state.toolsById.set(itemId, tool);
    state.emittedToolIds.add(itemId);
    events.push({
      kind: "toolStarted",
      itemId,
      toolName,
      title: tool.title,
      summary: tool.summary,
    });
  });
  return events;
}

function processUserToolResults(
  state: NormalizerState,
  message: { message?: unknown },
): ClaudeEvent[] {
  const content = messageContent(message);
  if (!Array.isArray(content)) return [];
  const events: ClaudeEvent[] = [];
  for (const entry of content) {
    const block = asRecord(entry);
    if (!block || block.type !== "tool_result") continue;
    const toolUseId = stringFromUnknown(block.tool_use_id);
    const tool = state.toolsById.get(toolUseId);
    if (!tool) continue;
    const isError = block.is_error === true;
    if (state.subagentToolUseIds.has(tool.itemId)) {
      events.push({ kind: "subagentCompleted", itemId: tool.itemId, isError });
      cleanupConsumedTool(state, toolUseId, tool.itemId);
      continue;
    }
    if (state.todoWriteToolUseIds.has(tool.itemId)) {
      cleanupConsumedTool(state, toolUseId, tool.itemId);
      continue;
    }
    const output = toolResultText(block);
    if (output) {
      events.push({
        kind: "toolOutput",
        itemId: tool.itemId,
        delta: output,
        isError,
      });
    }
    events.push({ kind: "toolCompleted", itemId: tool.itemId, isError });
    state.toolsById.delete(toolUseId);
  }
  return events;
}

function completeToolFromResultBlock(
  state: NormalizerState,
  block: Record<string, unknown>,
): ClaudeEvent[] {
  const toolUseId = stringFromUnknown(block.tool_use_id);
  const tool = state.toolsById.get(toolUseId);
  if (!tool) return [];
  const isError = block.is_error === true;
  if (state.subagentToolUseIds.has(tool.itemId)) {
    cleanupConsumedTool(state, toolUseId, tool.itemId);
    return [{ kind: "subagentCompleted", itemId: tool.itemId, isError }];
  }
  if (state.todoWriteToolUseIds.has(tool.itemId)) {
    cleanupConsumedTool(state, toolUseId, tool.itemId);
    return [];
  }
  const output = toolResultText(block);
  const events: ClaudeEvent[] = [];
  if (output) {
    events.push({ kind: "toolOutput", itemId: tool.itemId, delta: output, isError });
  }
  events.push({ kind: "toolCompleted", itemId: tool.itemId, isError });
  state.toolsById.delete(toolUseId);
  return events;
}

function cleanupConsumedTool(
  state: NormalizerState,
  toolUseId: string,
  itemId: string,
) {
  state.toolsById.delete(toolUseId);
  state.todoWriteToolUseIds.delete(itemId);
  state.subagentToolUseIds.delete(itemId);
  state.todoWriteFingerprints.delete(itemId);
}

function isToolUseBlock(block: Record<string, unknown>) {
  return block.type === "tool_use" ||
    block.type === "server_tool_use" ||
    block.type === "mcp_tool_use";
}

function isToolResultBlock(block: Record<string, unknown>) {
  return block.type === "web_search_tool_result" ||
    block.type === "web_fetch_tool_result";
}

function normalizeToolName(block: Record<string, unknown>) {
  const name = stringFromUnknown(block.name);
  if (name === "web_search") return "WebSearch";
  if (name === "web_fetch") return "WebFetch";
  return name || "Tool";
}

function createInFlightTool(
  itemId: string,
  toolName: string,
  input: Record<string, unknown>,
): InFlightTool {
  return {
    itemId,
    toolName,
    title: titleForTool(toolName),
    summary: summarizeTool(toolName, input),
    partialInputJson: "",
    lastInputFingerprint: Object.keys(input).length ? compactJson(input) : undefined,
  };
}

function assistantItemId(
  itemPrefix: string,
  state: NormalizerState,
  index: number | null,
) {
  return `${itemPrefix}-message-${state.messageOrdinal}-assistant-${index ?? 0}`;
}

function reasoningItemId(
  itemPrefix: string,
  state: NormalizerState,
  index: number | null,
) {
  return `${itemPrefix}-message-${state.messageOrdinal}-reasoning-${index ?? 0}`;
}

function toolItemId(
  itemPrefix: string,
  state: NormalizerState,
  index: number | null,
) {
  return `${itemPrefix}-message-${state.messageOrdinal}-tool-${index ?? 0}`;
}

export function summarizeTool(toolName: string, input: Record<string, unknown>) {
  const readPath = stringFromUnknown(input.file_path) || stringFromUnknown(input.path);
  switch (toolName) {
    case "Bash":
      return stringFromUnknown(input.description) || stringFromUnknown(input.command);
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
      return readPath;
    case "Grep":
    case "Glob":
      return summarizePatternSearch(input);
    case "LS":
      return readPath;
    case "WebSearch":
      return stringFromUnknown(input.query);
    case "WebFetch":
      return stringFromUnknown(input.url);
    case "TodoWrite":
      return "Task list";
    case "AskUserQuestion":
      return "User question";
    case "ExitPlanMode":
      return "Proposed plan";
    default:
      return readPath || compactJson(input);
  }
}

function summarizePatternSearch(input: Record<string, unknown>) {
  return [stringFromUnknown(input.pattern), stringFromUnknown(input.path)]
    .filter(Boolean)
    .join(" in ");
}

export function titleForTool(toolName: string) {
  switch (toolName) {
    case "Bash":
      return "Command";
    case "Read":
    case "LS":
    case "Glob":
    case "Grep":
      return "Search";
    case "Edit":
    case "MultiEdit":
    case "Write":
      return "File change";
    case "WebSearch":
    case "WebFetch":
      return "Web";
    case "TodoWrite":
      return "Task plan";
    case "AskUserQuestion":
      return "Question";
    case "ExitPlanMode":
      return "Plan";
    default:
      return toolName;
  }
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const entry = asRecord(block);
    if (entry?.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.join("\n\n");
}

function toolResultText(block: Record<string, unknown>) {
  const contentText = textFromContent(block.content).trim();
  if (contentText) return contentText;
  const content = block.content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => toolResultEntryText(asRecord(entry)))
      .filter(Boolean)
      .join("\n");
  }
  return toolResultEntryText(asRecord(content));
}

function toolResultEntryText(entry: Record<string, unknown> | null) {
  if (!entry) return "";
  if (entry.type === "web_search_result") {
    return [
      stringFromUnknown(entry.title),
      stringFromUnknown(entry.url),
    ].filter(Boolean).join(" - ");
  }
  if (entry.type === "web_fetch_result") {
    return stringFromUnknown(entry.url) || compactJson(entry);
  }
  return compactJson(entry);
}

export function compactJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function extractPlanFromInput(input: Record<string, unknown>): string | null {
  const plan = input.plan;
  return typeof plan === "string" && plan.trim() ? plan.trim() : null;
}

function emitTodoWritePlanIfChanged(
  state: NormalizerState,
  itemId: string,
  input: Record<string, unknown>,
): ClaudeEvent[] {
  const steps = stepsFromTodoWriteInput(input);
  const fingerprint = compactJson(steps);
  if (!fingerprint) return [];
  if (state.todoWriteFingerprints.get(itemId) === fingerprint) return [];
  state.todoWriteFingerprints.set(itemId, fingerprint);
  return [{ kind: "taskPlanUpdated", itemId, steps }];
}

function stepsFromTodoWriteInput(input: Record<string, unknown>): ClaudeTaskStep[] {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  const steps: ClaudeTaskStep[] = [];
  for (const entry of todos) {
    const todo = asRecord(entry);
    if (!todo) continue;
    const content =
      stringFromUnknown(todo.content).trim() ||
      stringFromUnknown(todo.activeForm).trim();
    if (!content) continue;
    steps.push({
      content,
      status: mapTodoStatus(stringFromUnknown(todo.status)),
    });
  }
  return steps;
}

function mapTodoStatus(value: string): ClaudeTaskStepStatus {
  if (value === "completed") return "completed";
  if (value === "in_progress" || value === "inProgress") return "inProgress";
  return "pending";
}

function buildSubagentStartedEvent(
  itemId: string,
  input: Record<string, unknown>,
): ClaudeEvent {
  const description =
    stringFromUnknown(input.description).trim() ||
    stringFromUnknown(input.name).trim() ||
    stringFromUnknown(input.prompt).trim().slice(0, 80);
  return {
    kind: "subagentStarted",
    itemId,
    description,
    subagentType: stringFromUnknown(input.subagent_type).trim() || "agent",
  };
}

function isSubagentToolName(toolName: string): boolean {
  return toolName === "Agent" || toolName === "Task";
}

function parsePartialJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function messageContent(message: { message?: unknown }) {
  const payload = asRecord(message.message);
  return payload?.content;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringFromUnknown(value: unknown) {
  return typeof value === "string" ? value : "";
}
