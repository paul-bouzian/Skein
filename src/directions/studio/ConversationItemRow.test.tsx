import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type {
  ConversationAutoApprovalReviewItem,
  ConversationMessageItem,
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
});

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
