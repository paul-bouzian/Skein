import { describe, expect, it } from "vitest";

import { deriveContextWindowSnapshot, formatContextWindowTokens } from "./context-window";

describe("context-window", () => {
  it("uses the latest thread usage as the context estimate and keeps total processed separate", () => {
    const snapshot = deriveContextWindowSnapshot({
      total: {
        totalTokens: 260_368,
        inputTokens: 100_000,
        cachedInputTokens: 40_000,
        outputTokens: 120_368,
        reasoningOutputTokens: 20_000,
      },
      last: {
        totalTokens: 36_000,
        inputTokens: 14_000,
        cachedInputTokens: 4_000,
        outputTokens: 18_000,
        reasoningOutputTokens: 2_000,
      },
      modelContextWindow: 258_000,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(36_000);
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.usedPercentage).toBeCloseTo((36_000 / 258_000) * 100, 4);
    expect(snapshot?.totalProcessedTokens).toBe(260_368);
  });

  it("returns null when there is no reliable context window estimate", () => {
    expect(
      deriveContextWindowSnapshot({
        total: {
          totalTokens: 1_000,
          inputTokens: 400,
          cachedInputTokens: 100,
          outputTokens: 500,
          reasoningOutputTokens: 50,
        },
        last: {
          totalTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 258_000,
      }),
    ).toBeNull();
  });

  it("prefers an explicit context window override over provider usage metadata", () => {
    const snapshot = deriveContextWindowSnapshot(
      {
        total: {
          totalTokens: 80_000,
          inputTokens: 60_000,
          cachedInputTokens: 0,
          outputTokens: 20_000,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 20_000,
          inputTokens: 18_000,
          cachedInputTokens: 0,
          outputTokens: 2_000,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 1_000_000,
      },
      200_000,
    );

    expect(snapshot?.maxTokens).toBe(200_000);
    expect(snapshot?.usedPercentage).toBe(10);
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1_400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(260_368)).toBe("260k");
  });
});
