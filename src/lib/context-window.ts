import type { ThreadTokenUsageSnapshot } from "./types";

export type ContextWindowSnapshot = {
  usedTokens: number;
  maxTokens: number;
  remainingTokens: number;
  usedPercentage: number;
  remainingPercentage: number;
  totalProcessedTokens: number | null;
};

export function deriveContextWindowSnapshot(
  usage: ThreadTokenUsageSnapshot | null | undefined,
  contextWindowOverride?: number | null,
): ContextWindowSnapshot | null {
  const usedTokens = usage?.last.totalTokens ?? 0;
  const maxTokens = contextWindowOverride ?? usage?.modelContextWindow ?? null;

  if (!maxTokens || maxTokens <= 0 || usedTokens <= 0) {
    return null;
  }

  const usedPercentage = Math.min(100, (usedTokens / maxTokens) * 100);
  return {
    usedTokens,
    maxTokens,
    remainingTokens: Math.max(0, Math.round(maxTokens - usedTokens)),
    usedPercentage,
    remainingPercentage: Math.max(0, 100 - usedPercentage),
    totalProcessedTokens: totalProcessedTokens(usage, usedTokens),
  };
}

export function formatContextWindowTokens(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function totalProcessedTokens(
  usage: ThreadTokenUsageSnapshot | null | undefined,
  usedTokens: number,
) {
  const totalTokens = usage?.total.totalTokens ?? 0;
  return totalTokens > usedTokens ? totalTokens : null;
}
