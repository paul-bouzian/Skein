import type { CodexRateLimitSnapshot, CodexRateLimitWindow } from "./types";

export type CodexUsageRowSnapshot = {
  label: "Session" | "Weekly";
  percentUsed: number | null;
  resetLabel: string;
};

const resetFormatter = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
});

export function buildCodexUsageRows(
  rateLimits: CodexRateLimitSnapshot | null | undefined,
  now = Date.now(),
): CodexUsageRowSnapshot[] {
  return [
    buildCodexUsageRow("Session", rateLimits?.primary, now),
    buildCodexUsageRow("Weekly", rateLimits?.secondary, now),
  ];
}

export function buildCodexUsageRow(
  label: CodexUsageRowSnapshot["label"],
  window: CodexRateLimitWindow | null | undefined,
  now = Date.now(),
): CodexUsageRowSnapshot {
  return {
    label,
    percentUsed: codexUsagePercent(window),
    resetLabel: formatCodexUsageResetLabel(window?.resetsAt, now) ?? "Unavailable",
  };
}

export function codexUsagePercent(
  window: CodexRateLimitWindow | null | undefined,
): number | null {
  if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) {
    return null;
  }
  return Math.min(Math.max(Math.round(window.usedPercent), 0), 100);
}

export function formatCodexUsageResetLabel(
  resetsAt: number | null | undefined,
  now = Date.now(),
): string | null {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) {
    return null;
  }

  const resetAtMs = resetsAt > 1_000_000_000_000 ? resetsAt : resetsAt * 1000;
  const diffMs = resetAtMs - now;
  if (diffMs <= 0) {
    return "Reset due now";
  }

  const { value, unit } = relativeResetWindow(diffMs);

  return `Resets ${resetFormatter.format(value, unit as Intl.RelativeTimeFormatUnit)}`;
}

function relativeResetWindow(diffMs: number) {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs >= day) {
    return { value: Math.round(diffMs / day), unit: "day" };
  }
  if (diffMs >= hour) {
    return { value: Math.round(diffMs / hour), unit: "hour" };
  }
  if (diffMs >= minute) {
    return { value: Math.round(diffMs / minute), unit: "minute" };
  }

  return {
    value: Math.max(1, Math.round(diffMs / 1000)),
    unit: "second",
  };
}
