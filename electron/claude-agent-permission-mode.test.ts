import { describe, expect, it } from "vitest";

import { claudePermissionMode } from "./claude-agent-permission-mode";

describe("claudePermissionMode", () => {
  it("maps approval policies to Claude Agent SDK permission modes", () => {
    expect(claudePermissionMode("build", "askToEdit")).toBe("default");
    expect(claudePermissionMode("build", "autoReview")).toBe("auto");
    expect(claudePermissionMode("build", "fullAccess")).toBe("bypassPermissions");
  });

  it("keeps plan mode authoritative over approval policy", () => {
    expect(claudePermissionMode("plan", "autoReview")).toBe("plan");
    expect(claudePermissionMode("plan", "fullAccess")).toBe("plan");
  });
});
