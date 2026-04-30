import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ThreadComposerCatalog } from "../../lib/types";
import { ComposerTokenText } from "./ComposerTokenText";

const catalog: ThreadComposerCatalog = {
  prompts: [
    {
      name: "review-long-command",
      description: "Review the current change",
      argumentMode: "none",
      argumentNames: [],
      positionalCount: 0,
      argumentHint: null,
    },
  ],
  skills: [
    {
      name: "create-pr",
      description: "Create a PR",
      path: "/tmp/create-pr",
    },
  ],
  apps: [],
};

describe("ComposerTokenText", () => {
  it("renders editable token text when the caret is inside a decorated token", () => {
    render(
      <div data-testid="text">
        <ComposerTokenText
          text="Use $create-pr now"
          catalog={catalog}
          cursorIndex={"Use $cre".length}
          provider="codex"
          keyPrefix="test"
          showCaret
        />
      </div>,
    );

    const root = screen.getByTestId("text");
    expect(root).toHaveTextContent("Use $create-pr now");
    expect(root.querySelector(".tx-inline-token-badge")).toBeNull();
    expect(
      root.querySelector(".tx-inline-composer__visual-caret"),
    ).not.toBeNull();
  });

  it("renders source prompt text when the visual caret is at a prompt boundary", () => {
    const text = "/prompts:review-long-command()";

    render(
      <div data-testid="text">
        <ComposerTokenText
          text={text}
          catalog={catalog}
          cursorIndex={text.length}
          provider="codex"
          keyPrefix="test"
          showCaret
        />
      </div>,
    );

    const root = screen.getByTestId("text");
    expect(root).toHaveTextContent(text);
    expect(root.querySelector(".tx-inline-token-badge")).toBeNull();
    expect(
      root.querySelector(".tx-inline-composer__visual-caret"),
    ).not.toBeNull();
  });

  it("renders source skill text when the visual caret is at a token boundary", () => {
    const text = "$create-pr";

    render(
      <div data-testid="text">
        <ComposerTokenText
          text={text}
          catalog={catalog}
          cursorIndex={text.length}
          provider="codex"
          keyPrefix="test"
          showCaret
        />
      </div>,
    );

    const root = screen.getByTestId("text");
    expect(root).toHaveTextContent(text);
    expect(root.querySelector(".tx-inline-token-badge")).toBeNull();
    expect(
      root.querySelector(".tx-inline-composer__visual-caret"),
    ).not.toBeNull();
  });
});
