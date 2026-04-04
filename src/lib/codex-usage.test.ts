import { describe, expect, it } from "vitest";

import { buildCodexUsageRows, formatCodexUsageResetLabel } from "./codex-usage";

describe("codex usage helpers", () => {
  it("builds session and weekly rows from account rate limits", () => {
    const rows = buildCodexUsageRows(
      {
        primary: {
          usedPercent: 38,
          windowDurationMins: 300,
          resetsAt: 1_775_306_400,
        },
        secondary: {
          usedPercent: 12,
          windowDurationMins: 10_080,
          resetsAt: 1_775_910_400,
        },
      },
      1_775_300_000_000,
    );

    expect(rows).toEqual([
      {
        label: "Session",
        percentUsed: 38,
        resetLabel: "Resets in 2 hours",
      },
      {
        label: "Weekly",
        percentUsed: 12,
        resetLabel: "Resets in 7 days",
      },
    ]);
  });

  it("keeps unavailable windows visible as placeholders", () => {
    expect(buildCodexUsageRows(null)).toEqual([
      {
        label: "Session",
        percentUsed: null,
        resetLabel: "Unavailable",
      },
      {
        label: "Weekly",
        percentUsed: null,
        resetLabel: "Unavailable",
      },
    ]);
  });

  it("supports reset timestamps expressed in milliseconds", () => {
    expect(formatCodexUsageResetLabel(1_775_303_600_000, 1_775_300_000_000)).toBe(
      "Resets in 1 hour",
    );
  });
});
