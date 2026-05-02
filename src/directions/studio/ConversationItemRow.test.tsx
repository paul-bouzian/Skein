import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type {
  ConversationAutoApprovalReviewItem,
  ConversationMessageItem,
  ConversationReasoningItem,
  ConversationToolItem,
} from "../../lib/types";
import { ConversationItemRow } from "./ConversationItemRow";

describe("ConversationItemRow", () => {
  it("labels Claude assistant messages as Claude", () => {
    render(
      <ConversationItemRow
        provider="claude"
        item={messageItem({ id: "assistant-claude", text: "Bonjour" })}
      />,
    );

    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("renders user composer commands as visual badges", () => {
    render(
      <ConversationItemRow
        provider="claude"
        item={messageItem({
          id: "user-command",
          role: "user",
          text: "Use /prompts:review() with $create-pr, $github and /release-notes",
          mentionBindings: [
            { mention: "github", kind: "app", path: "app://github" },
          ],
        })}
      />,
    );

    const promptBadge = screen
      .getByText("/review")
      .closest(".tx-inline-token-badge");
    const skillBadge = screen
      .getByText("$create-pr")
      .closest(".tx-inline-token-badge");
    const slashBadge = screen
      .getByText("/release-notes")
      .closest(".tx-inline-token-badge");
    const appBadge = screen
      .getByText("$github")
      .closest(".tx-inline-token-badge");

    expect(promptBadge).not.toBeNull();
    expect(promptBadge).toHaveAttribute("title", "/prompts:review()");
    expect(skillBadge).not.toBeNull();
    expect(skillBadge).toHaveAttribute("title", "$create-pr");
    expect(appBadge).not.toBeNull();
    expect(appBadge).toHaveClass("tx-inline-token--app");
    expect(slashBadge).not.toBeNull();
    expect(slashBadge).toHaveAttribute("title", "/release-notes");
    expect(
      screen.getByRole("button", { name: "Copy message" }),
    ).toBeInTheDocument();
  });

  it("does not render assistant text as unknown composer badges", () => {
    const { container } = render(
      <ConversationItemRow
        provider="claude"
        item={messageItem({
          id: "assistant-command-text",
          role: "assistant",
          text: "Assistant output can mention /review and $foo-bar literally.",
        })}
      />,
    );

    expect(container.querySelector(".tx-inline-token-badge")).toBeNull();
  });

  it("does not render arbitrary user at-mentions as file badges", () => {
    const { container } = render(
      <ConversationItemRow
        provider="codex"
        item={messageItem({
          id: "user-at-mention-text",
          role: "user",
          text: "Please ask @alice and @qa-team.",
        })}
      />,
    );

    expect(screen.getByText("Please ask @alice and @qa-team.")).toBeInTheDocument();
    expect(container.querySelector(".tx-inline-token--file")).toBeNull();
  });

  it("renders Codex auto-review status and risk details", async () => {
    render(
      <ConversationItemRow
        provider="codex"
        item={autoReviewItem({
          status: "approved",
          riskLevel: "high",
          userAuthorization: "high",
        })}
      />,
    );

    expect(screen.getByText("Command auto-review")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Risk: High")).toBeInTheDocument();

    const toggle = screen.getByRole("button", {
      name: "Show Command auto-review details",
      description: "Risk: High Approved",
    });
    await userEvent.click(toggle);

    expect(screen.getByText("git push origin feature")).toBeInTheDocument();
    expect(screen.getByText("User explicitly requested this action.")).toBeInTheDocument();
    expect(screen.getByText(/Auth: High/)).toBeInTheDocument();
  });

  it.each([
    [
      "Codex tool summary",
      toolItem({
        id: "codex-command",
        toolType: "commandExecution",
        title: "Command",
        summary: "bun run verify",
        output: "All checks passed",
      }),
      "codex",
      "bun run verify",
    ],
    [
      "Claude tool output fallback",
      toolItem({
        id: "claude-web",
        toolType: "WebSearch",
        title: "Web",
        summary: "   ",
        output: "Streaming output\nhttps://code.claude.com/docs",
      }),
      "claude",
      "Streaming output https://code.claude.com/docs",
    ],
    [
      "reasoning summary",
      reasoningItem({
        summary: "Inspecting the workspace",
        content: "Reading package manifests.",
      }),
      "codex",
      "Inspecting the workspace",
    ],
    [
      "reasoning content fallback",
      reasoningItem({
        summary: "\n",
        content: "Checking runtime session state\nand provider events.",
      }),
      "codex",
      "Checking runtime session state and provider events.",
    ],
    [
      "bounded long output fallback",
      toolItem({
        summary: "",
        output: `${"a".repeat(700)} visible after limit`,
      }),
      "codex",
      "a".repeat(600),
    ],
  ] as const)("renders a compact preview from %s", (_case, item, provider, expected) => {
    const { container } = render(
      <ConversationItemRow
        compact
        provider={provider}
        item={item}
      />,
    );

    expect(previewElement(container)).toHaveTextContent(expected);
  });

  it("omits compact previews when the source content is blank", () => {
    const { container } = render(
      <ConversationItemRow
        compact
        item={toolItem({ summary: "   ", output: "\n\n" })}
      />,
    );

    expect(previewElement(container)).toBeNull();
  });

  it("exposes compact previews as button descriptions", () => {
    render(
      <ConversationItemRow
        compact
        item={toolItem({ summary: "bun run verify" })}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Show Command details",
        description: "bun run verify",
      }),
    ).toBeInTheDocument();
  });
});

function previewElement(container: HTMLElement) {
  return container.querySelector(".tx-item__preview");
}

function messageItem(
  overrides: Partial<ConversationMessageItem> = {},
): ConversationMessageItem {
  return {
    kind: "message",
    id: "assistant-1",
    turnId: "turn-1",
    role: "assistant",
    text: "Ready.",
    images: null,
    isStreaming: false,
    ...overrides,
  };
}

function autoReviewItem(
  overrides: Partial<ConversationAutoApprovalReviewItem> = {},
): ConversationAutoApprovalReviewItem {
  return {
    kind: "autoApprovalReview",
    id: "auto-review-review-1",
    turnId: "turn-1",
    reviewId: "review-1",
    targetItemId: "tool-1",
    actionKind: "command",
    title: "Command auto-review",
    status: "inProgress",
    riskLevel: null,
    userAuthorization: null,
    rationale: "User explicitly requested this action.",
    summary: "git push origin feature",
    ...overrides,
  };
}

function toolItem(overrides: Partial<ConversationToolItem> = {}): ConversationToolItem {
  return {
    kind: "tool",
    id: "tool-1",
    turnId: "turn-1",
    toolType: "commandExecution",
    title: "Command",
    status: "completed",
    summary: "bun run test",
    output: "3 tests passed",
    ...overrides,
  };
}

function reasoningItem(
  overrides: Partial<ConversationReasoningItem> = {},
): ConversationReasoningItem {
  return {
    kind: "reasoning",
    id: "reasoning-1",
    turnId: "turn-1",
    summary: "Thinking through the task",
    content: "",
    isStreaming: false,
    ...overrides,
  };
}
