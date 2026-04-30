import { describe, expect, it } from "vitest";

import { claudeContextWindowForModel } from "../src/lib/claude-context-window";

describe("claudeContextWindowForModel", () => {
  it("uses the default context window unless the selected model explicitly enables 1M", () => {
    expect(claudeContextWindowForModel("claude-opus-4-7")).toBe(200_000);
    expect(claudeContextWindowForModel("claude-opus-4-7[1m]")).toBe(1_000_000);
  });
});
