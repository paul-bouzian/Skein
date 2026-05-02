import { describe, expect, it } from "vitest";

import {
  claudeBaseModelId,
  claudeContextWindowForModel,
  claudeOneMillionModelId,
  claudeUsesOneMillionContext,
} from "../src/lib/claude-context-window";

describe("claude context model ids", () => {
  it("keeps context mode encoded in the selected model id", () => {
    expect(claudeBaseModelId("claude-opus-4-7[1m]")).toBe("claude-opus-4-7");
    expect(claudeOneMillionModelId("claude-opus-4-7")).toBe(
      "claude-opus-4-7[1m]",
    );
    expect(claudeUsesOneMillionContext("claude-opus-4-7")).toBe(false);
    expect(claudeUsesOneMillionContext("claude-opus-4-7[1m]")).toBe(true);
  });

  it("maps selected Claude context mode to the effective fallback window", () => {
    expect(claudeContextWindowForModel("claude-opus-4-7")).toBe(200_000);
    expect(claudeContextWindowForModel("claude-opus-4-7[1m]")).toBe(1_000_000);
  });
});
