import { describe, expect, it } from "vitest";

import { tokenUsageEventFor } from "./claude-agent-usage.js";

describe("Claude agent usage", () => {
  it("uses SDK context usage for the current context window", async () => {
    const event = await tokenUsageEventFor(
      {
        getContextUsage: async () => ({
          totalTokens: 36_000,
          maxTokens: 200_000,
          rawMaxTokens: 1_000_000,
        }),
      },
      "claude-opus-4-7",
      {
        input_tokens: 1_100_000,
        cache_read_input_tokens: 100_000,
        output_tokens: 12_000,
      },
    );

    expect(event).toMatchObject({
      kind: "tokenUsage",
      total: {
        totalTokens: 1_212_000,
        inputTokens: 1_100_000,
        cachedInputTokens: 100_000,
        outputTokens: 12_000,
      },
      last: {
        totalTokens: 36_000,
      },
      modelContextWindow: 200_000,
    });
  });

  it("uses one million when the SDK reports it as the effective window", async () => {
    const event = await tokenUsageEventFor(
      {
        getContextUsage: async () => ({
          totalTokens: 240_000,
          maxTokens: 1_000_000,
        }),
      },
      "claude-opus-4-7[1m]",
      null,
    );

    expect(event).toMatchObject({
      kind: "tokenUsage",
      total: {
        totalTokens: 240_000,
      },
      last: {
        totalTokens: 240_000,
      },
      modelContextWindow: 1_000_000,
    });
  });

  it("falls back to the selected default model context when live context usage is unavailable", async () => {
    const event = await tokenUsageEventFor(
      {
        getContextUsage: async () => {
          throw new Error("context unavailable");
        },
      },
      "claude-opus-4-7",
      {
        input_tokens: 1_100_000,
        cache_read_input_tokens: 100_000,
        output_tokens: 12_000,
      },
    );

    expect(event).toMatchObject({
      kind: "tokenUsage",
      total: {
        totalTokens: 1_212_000,
      },
      last: {
        totalTokens: 1_212_000,
      },
    });
    expect(event?.modelContextWindow).toBe(200_000);
  });

  it("falls back to the selected model context when SDK metadata is unavailable", async () => {
    const event = await tokenUsageEventFor(
      {
        getContextUsage: async () => {
          throw new Error("context unavailable");
        },
      },
      "claude-opus-4-7[1m]",
      {
        input_tokens: 12_000,
        output_tokens: 1_000,
      },
    );

    expect(event?.modelContextWindow).toBe(1_000_000);
  });

  it("keeps SDK context windows even when usage has reached or passed the limit", async () => {
    const event = await tokenUsageEventFor(
      {
        getContextUsage: async () => ({
          totalTokens: 1_200_000,
          maxTokens: 200_000,
        }),
      },
      "claude-opus-4-7",
      null,
    );

    expect(event).toMatchObject({
      kind: "tokenUsage",
      total: {
        totalTokens: 1_200_000,
      },
      last: {
        totalTokens: 1_200_000,
      },
      modelContextWindow: 200_000,
    });
  });

  it("falls back to selected model context when context usage omits a positive max", async () => {
    const event = await tokenUsageEventFor(
      {
        getContextUsage: async () => ({
          totalTokens: 42_000,
          maxTokens: 0,
        }),
      },
      "claude-opus-4-7",
      null,
    );

    expect(event?.modelContextWindow).toBe(200_000);
  });

  it("falls back to raw max tokens when max tokens are not present", async () => {
    const event = await tokenUsageEventFor(
      {
        getContextUsage: async () => ({
          totalTokens: 42_000,
          rawMaxTokens: 1_000_000,
        }),
      },
      "claude-opus-4-7",
      null,
    );

    expect(event?.modelContextWindow).toBe(1_000_000);
  });
});
