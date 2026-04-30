import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ThreadComposerCatalog } from "../../lib/types";
import { ComposerTokenText } from "./ComposerTokenText";

const catalog: ThreadComposerCatalog = {
  prompts: [],
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
});
