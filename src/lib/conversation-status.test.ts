import { describe, expect, it } from "vitest";

import {
  deriveEnvironmentConversationStatus,
  indicatorToneForConversationStatus,
  indicatorToneForThreadConversation,
  labelForConversationStatus,
  toneForConversationStatus,
} from "./conversation-status";
import {
  baseComposer,
  makeApprovalRequest,
  makeConversationSnapshot,
  makeEnvironment,
  makeProposedPlan,
  makeThread,
} from "../test/fixtures/conversation";
import type {
  CollaborationMode,
  ThreadConversationSnapshot,
} from "./types";

function makeRunningSnapshot(
  collaborationMode: CollaborationMode,
  overrides: Partial<ThreadConversationSnapshot> = {},
): ThreadConversationSnapshot {
  return makeConversationSnapshot({
    status: "running",
    composer: {
      ...baseComposer,
      collaborationMode,
    },
    ...overrides,
  });
}

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

  it("maps running plan-mode threads to the planning indicator", () => {
    expect(
      indicatorToneForThreadConversation(makeRunningSnapshot("plan")),
    ).toBe("planning");
  });

  it("maps running build-mode threads to the progress indicator", () => {
    expect(
      indicatorToneForThreadConversation(makeRunningSnapshot("build")),
    ).toBe("progress");
  });

  it("prioritizes awaiting action over planning", () => {
    expect(
      indicatorToneForThreadConversation(
        makeRunningSnapshot("plan", {
          pendingInteractions: [makeApprovalRequest()],
        }),
      ),
    ).toBe("waiting");

    expect(
      indicatorToneForThreadConversation(
        makeRunningSnapshot("plan", {
          proposedPlan: makeProposedPlan({ isAwaitingDecision: true }),
        }),
      ),
    ).toBe("waiting");
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

  it("keeps running environments neutral when they have no active threads", () => {
    const environment = makeEnvironment({
      runtime: {
        environmentId: "env-1",
        state: "running",
      },
      threads: [],
    });

    expect(deriveEnvironmentConversationStatus(environment, {})).toBe("idle");
  });

  it("ignores archived persisted conversation history for environment activity", () => {
    const environment = makeEnvironment({
      runtime: {
        environmentId: "env-1",
        state: "stopped",
      },
      threads: [
        makeThread({
          codexThreadId: "thr-existing",
          status: "archived",
        }),
      ],
    });

    expect(deriveEnvironmentConversationStatus(environment, {})).toBe("idle");
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

  it("keeps stopped environments with persisted conversation history neutral", () => {
    const environment = makeEnvironment({
      runtime: {
        environmentId: "env-1",
        state: "stopped",
      },
      threads: [
        makeThread({
          codexThreadId: "thr-existing",
        }),
      ],
    });

    expect(deriveEnvironmentConversationStatus(environment, {})).toBe("idle");
  });

  it("treats exited environments with persisted conversation history as interrupted", () => {
    const environment = makeEnvironment({
      runtime: {
        environmentId: "env-1",
        state: "exited",
      },
      threads: [
        makeThread({
          codexThreadId: "thr-existing",
        }),
      ],
    });

    expect(deriveEnvironmentConversationStatus(environment, {})).toBe("interrupted");
  });
});
