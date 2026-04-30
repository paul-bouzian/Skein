import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConversationMessageItem } from "../../lib/types";
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
