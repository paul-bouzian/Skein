import type { ClaudeEvent, TokenUsageBreakdown } from "./claude-agent-events.js";
import { claudeContextWindowForModel } from "../src/lib/claude-context-window.js";

type ClaudeTokenUsageEvent = Extract<ClaudeEvent, { kind: "tokenUsage" }>;

export async function tokenUsageEventFor(
  conversation: { getContextUsage?: () => Promise<unknown> },
  model: string,
  resultUsage: unknown,
): Promise<ClaudeTokenUsageEvent | null> {
  const contextUsage =
    typeof conversation.getContextUsage === "function"
      ? await conversation.getContextUsage().catch(() => null)
      : null;
  const contextBreakdown = tokenUsageBreakdownFromContextUsage(contextUsage);
  const modelContextWindow =
    modelContextWindowFromContextUsage(contextUsage) ??
    claudeContextWindowForModel(model);
  const totalBreakdown =
    tokenUsageBreakdownFromUsage(resultUsage) ?? contextBreakdown;

  if (!totalBreakdown) {
    return null;
  }

  return {
    kind: "tokenUsage",
    total: totalBreakdown,
    last: contextBreakdown ?? totalBreakdown,
    modelContextWindow,
  };
}

function modelContextWindowFromContextUsage(value: unknown): number | null {
  const maxTokens =
    numberField(value, "maxTokens", "max_tokens") ??
    numberField(value, "rawMaxTokens", "raw_max_tokens");
  return maxTokens !== null && maxTokens > 0 ? maxTokens : null;
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
  const inputTokens = tokenCountField(value, "input_tokens", "inputTokens");
  const cacheReadInputTokens = tokenCountField(
    value,
    "cache_read_input_tokens",
    "cacheReadInputTokens",
  );
  const cacheCreationInputTokens = tokenCountField(
    value,
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
  );
  const outputTokens = tokenCountField(value, "output_tokens", "outputTokens");
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

function tokenCountField(value: unknown, ...keys: string[]): number {
  return Math.max(0, numberField(value, ...keys) ?? 0);
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
