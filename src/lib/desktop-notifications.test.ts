import { describe, expect, it } from "vitest";

import {
  collectDesktopNotificationCandidates,
} from "./desktop-notifications";
import {
  makeApprovalRequest,
  makeConversationSnapshot,
  makeProposedPlan,
  makeUserInputRequest,
} from "../test/fixtures/conversation";

describe("collectDesktopNotificationCandidates", () => {
  it("does not notify on initial hydration", () => {
    const candidates = collectDesktopNotificationCandidates(
      {},
      {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          status: "running",
          activeTurnId: "turn-1",
        }),
      },
    );

    expect(candidates).toEqual([]);
  });

  it("can suppress unknown threads during initial hydration when asked explicitly", () => {
    const candidates = collectDesktopNotificationCandidates(
      {},
      {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          status: "waitingForExternalAction",
          activeTurnId: "turn-1",
          pendingInteractions: [makeApprovalRequest()],
          proposedPlan: null,
        }),
      },
      { suppressUnknownThreads: true },
    );

    expect(candidates).toEqual([]);
  });

  it("emits one completion candidate when a running thread completes", () => {
    const candidates = collectDesktopNotificationCandidates(
      {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          status: "running",
          activeTurnId: "turn-1",
        }),
      },
      {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          status: "completed",
          activeTurnId: null,
          pendingInteractions: [],
          proposedPlan: null,
        }),
      },
    );

    expect(candidates).toEqual([
      {
        threadId: "thread-1",
        kind: "completed",
      },
    ]);
  });

  it("does not re-emit completion when the snapshot stays completed", () => {
    const completedSnapshot = makeConversationSnapshot({
      threadId: "thread-1",
      status: "completed",
      activeTurnId: null,
      pendingInteractions: [],
      proposedPlan: null,
    });

    const candidates = collectDesktopNotificationCandidates(
      { "thread-1": completedSnapshot },
      { "thread-1": completedSnapshot },
    );

    expect(candidates).toEqual([]);
  });

  it("emits one approval attention candidate for a new approval request", () => {
    const candidates = collectDesktopNotificationCandidates(
      {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          status: "running",
          activeTurnId: "turn-1",
          pendingInteractions: [],
          proposedPlan: null,
        }),
      },
      {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          status: "waitingForExternalAction",
          activeTurnId: "turn-1",
          pendingInteractions: [makeApprovalRequest()],
          proposedPlan: null,
        }),
      },
    );

    expect(candidates).toEqual([
      {
        threadId: "thread-1",
        kind: "attention",
        attentionKind: "approval",
        attentionKey: "approval:interaction-approval-1",
      },
    ]);
  });

  it("emits one user input attention candidate for a new request", () => {
    const candidates = collectDesktopNotificationCandidates(
      {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          status: "running",
          activeTurnId: "turn-1",
          pendingInteractions: [],
          proposedPlan: null,
        }),
      },
      {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          status: "waitingForExternalAction",
          activeTurnId: "turn-1",
          pendingInteractions: [makeUserInputRequest()],
          proposedPlan: null,
        }),
      },
    );

    expect(candidates).toEqual([
      {
        threadId: "thread-1",
        kind: "attention",
        attentionKind: "userInput",
        attentionKey: "userInput:interaction-user-input-1",
      },
    ]);
  });

  it("emits one plan attention candidate when a plan starts awaiting a decision", () => {
    const candidates = collectDesktopNotificationCandidates(
      {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          status: "running",
          activeTurnId: "turn-1",
          pendingInteractions: [],
          proposedPlan: null,
        }),
      },
      {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          status: "waitingForExternalAction",
          activeTurnId: "turn-1",
          pendingInteractions: [],
          proposedPlan: makeProposedPlan(),
        }),
      },
    );

    expect(candidates).toEqual([
      {
        threadId: "thread-1",
        kind: "attention",
        attentionKind: "plan",
        attentionKey: "plan:turn-plan-1:plan-item-1",
      },
    ]);
  });

  it("emits attention for a newly observed thread after initial hydration", () => {
    const candidates = collectDesktopNotificationCandidates(
      {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          status: "running",
          activeTurnId: "turn-1",
          pendingInteractions: [],
          proposedPlan: null,
        }),
      },
      {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          status: "running",
          activeTurnId: "turn-1",
          pendingInteractions: [],
          proposedPlan: null,
        }),
        "thread-2": makeConversationSnapshot({
          threadId: "thread-2",
          status: "waitingForExternalAction",
          activeTurnId: "turn-2",
          pendingInteractions: [makeApprovalRequest({ id: "approval-2" })],
          proposedPlan: null,
        }),
      },
    );

    expect(candidates).toEqual([
      {
        threadId: "thread-2",
        kind: "attention",
        attentionKind: "approval",
        attentionKey: "approval:approval-2",
      },
    ]);
  });

  it("does not re-emit the same attention key on later snapshots", () => {
    const waitingSnapshot = makeConversationSnapshot({
      threadId: "thread-1",
      status: "waitingForExternalAction",
      activeTurnId: "turn-1",
      pendingInteractions: [makeUserInputRequest()],
      proposedPlan: null,
    });

    const candidates = collectDesktopNotificationCandidates(
      { "thread-1": waitingSnapshot },
      { "thread-1": waitingSnapshot },
    );

    expect(candidates).toEqual([]);
  });
});
