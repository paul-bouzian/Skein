import { describe, expect, it } from "vitest";

import {
  deriveEnvironmentConversationStatus,
  indicatorToneForConversationStatus,
  labelForConversationStatus,
  toneForConversationStatus,
} from "./conversation-status";
import { makeConversationSnapshot, makeEnvironment, makeThread } from "../test/fixtures/conversation";

describe("conversation status helpers", () => {
  it("maps waiting threads to an awaiting-action label and tone", () => {
    expect(labelForConversationStatus("waitingForExternalAction")).toBe("Awaiting action");
    expect(toneForConversationStatus("waitingForExternalAction")).toBe("waiting");
    expect(indicatorToneForConversationStatus("running")).toBe("progress");
  });

  it("treats interrupted threads as neutral instead of warning", () => {
    expect(toneForConversationStatus("interrupted")).toBe("neutral");
    expect(indicatorToneForConversationStatus("interrupted")).toBe("neutral");
  });

  it("prioritizes waiting snapshots over completed ones for an environment", () => {
    const environment = makeEnvironment({
      threads: [
        makeThread({
          id: "thread-completed",
          updatedAt: "2026-04-04T17:59:00Z",
        }),
        makeThread({
          id: "thread-waiting",
          updatedAt: "2026-04-04T18:00:00Z",
        }),
      ],
    });

    const status = deriveEnvironmentConversationStatus(environment, {
      "thread-completed": makeConversationSnapshot({
        threadId: "thread-completed",
        status: "completed",
      }),
      "thread-waiting": makeConversationSnapshot({
        threadId: "thread-waiting",
        status: "waitingForExternalAction",
      }),
    });

    expect(status).toBe("waitingForExternalAction");
  });

  it("prioritizes running snapshots over completed ones for an environment", () => {
    const environment = makeEnvironment({
      threads: [
        makeThread({
          id: "thread-completed",
          updatedAt: "2026-04-04T17:59:00Z",
        }),
        makeThread({
          id: "thread-running",
          updatedAt: "2026-04-04T18:00:00Z",
        }),
      ],
    });

    const status = deriveEnvironmentConversationStatus(environment, {
      "thread-completed": makeConversationSnapshot({
        threadId: "thread-completed",
        status: "completed",
      }),
      "thread-running": makeConversationSnapshot({
        threadId: "thread-running",
        status: "running",
      }),
    });

    expect(status).toBe("running");
  });

  it("only shows completed when every active thread is completed", () => {
    const environment = makeEnvironment({
      threads: [
        makeThread({
          id: "thread-completed",
          updatedAt: "2026-04-04T17:59:00Z",
        }),
        makeThread({
          id: "thread-idle",
          updatedAt: "2026-04-04T18:00:00Z",
        }),
      ],
    });

    const status = deriveEnvironmentConversationStatus(environment, {
      "thread-completed": makeConversationSnapshot({
        threadId: "thread-completed",
        status: "completed",
      }),
      "thread-idle": makeConversationSnapshot({
        threadId: "thread-idle",
        status: "idle",
      }),
    });

    expect(status).toBe("idle");
  });

  it("falls back to the runtime state when no thread snapshot is loaded", () => {
    const environment = makeEnvironment({
      runtime: {
        environmentId: "env-1",
        state: "running",
      },
      threads: [makeThread()],
    });

    expect(deriveEnvironmentConversationStatus(environment, {})).toBe("running");
  });

  it("keeps stopped environments neutral when active threads have no snapshots yet", () => {
    const environment = makeEnvironment({
      runtime: {
        environmentId: "env-1",
        state: "stopped",
      },
      threads: [makeThread()],
    });

    expect(deriveEnvironmentConversationStatus(environment, {})).toBe("idle");
  });
});
