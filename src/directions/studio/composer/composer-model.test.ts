import { describe, expect, it } from "vitest";

import type { ThreadComposerCatalog } from "../../../lib/types";
import {
  buildAutocompleteItems,
  buildPromptInsertText,
  decorateComposerText,
  findActiveComposerToken,
  findComposerTokenDeletionRange,
} from "./composer-model";

const catalog: ThreadComposerCatalog = {
  prompts: [],
  skills: [
    {
      name: "create-pr",
      description: "Create a PR",
      path: "/tmp/create-pr",
    },
  ],
  apps: [
    {
      id: "github",
      name: "GitHub",
      description: "GitHub connector",
      slug: "github",
      path: "app://github",
    },
  ],
};

describe("composer-model", () => {
  it("detects mention tokens after punctuation", () => {
    const text = "Please try:$cre";
    const token = findActiveComposerToken(text, text.length, text.length);

    expect(token).toEqual({
      kind: "mention",
      start: 11,
      end: 15,
      raw: "$cre",
      query: "cre",
    });
  });

  it("decorates mention tokens after punctuation", () => {
    const segments = decorateComposerText("Please try:$github", catalog);

    expect(segments).toEqual([
      { kind: "text", text: "Please try:" },
      { kind: "app", text: "$github", start: 11, end: 18 },
    ]);
  });

  it("builds Codex dollar suggestions with mention bindings", () => {
    const token = findActiveComposerToken("Use $cre", 8, 8);
    const items = buildAutocompleteItems(token, catalog, [], "codex");

    expect(items).toEqual([
      expect.objectContaining({
        group: "Skills",
        insertText: "$create-pr",
        mentionBinding: {
          mention: "create-pr",
          kind: "skill",
          path: "/tmp/create-pr",
        },
      }),
    ]);
  });

  it("builds Codex slash suggestions from prompt options", () => {
    const token = findActiveComposerToken("/rel", 4, 4);
    const items = buildAutocompleteItems(
      token,
      {
        prompts: [
          {
            name: "release",
            description: "Draft a release note",
            argumentMode: "none",
            argumentNames: [],
            positionalCount: 0,
            argumentHint: null,
          },
        ],
        skills: [],
        apps: [],
      },
      [],
      "codex",
    );

    expect(items).toEqual([
      expect.objectContaining({
        group: "Prompts",
        label: "prompts:release",
        insertText: "/prompts:release()",
      }),
    ]);
  });

  it("places prompt cursor at the end when no argument placeholder exists", () => {
    expect(
      buildPromptInsertText({
        name: "empty-named",
        description: "No named args yet",
        argumentMode: "named",
        argumentNames: [],
        positionalCount: 0,
        argumentHint: null,
      }),
    ).toEqual({
      text: "/prompts:empty-named()",
      cursorOffset: "/prompts:empty-named()".length,
      appendSpace: false,
    });
  });

  it("builds Claude slash suggestions from commands only", () => {
    const token = findActiveComposerToken("/re", 3, 3);
    const items = buildAutocompleteItems(
      token,
      {
        prompts: [
          {
            name: "release-notes",
            description: "Draft release notes",
            argumentMode: "positional",
            argumentNames: [],
            positionalCount: 0,
            argumentHint: "<version>",
          },
        ],
        skills: [
          {
            name: "review",
            description: "Review the current diff",
            path: "/tmp/.claude/skills/review/SKILL.md",
          },
        ],
        apps: [],
      },
      [],
      "claude",
    );

    expect(items).toEqual([
      expect.objectContaining({
        group: "Commands",
        label: "/release-notes",
        insertText: "/release-notes",
      }),
    ]);
  });

  it("decorates Claude slash commands and dollar skills separately", () => {
    const segments = decorateComposerText(
      "Run /release-notes and $review but keep /review raw",
      {
        prompts: [
          {
            name: "release-notes",
            description: "Draft release notes",
            argumentMode: "positional",
            argumentNames: [],
            positionalCount: 0,
            argumentHint: "<version>",
          },
        ],
        skills: [
          {
            name: "review",
            description: "Review the current diff",
            path: "/tmp/.claude/skills/review/SKILL.md",
          },
        ],
        apps: [],
      },
      "claude",
    );

    expect(segments).toEqual([
      { kind: "text", text: "Run " },
      {
        kind: "prompt",
        text: "/release-notes",
        parts: [{ text: "/release-notes", tone: "base" }],
        start: 4,
        end: 18,
      },
      { kind: "text", text: " and " },
      { kind: "skill", text: "$review", start: 23, end: 30 },
      { kind: "text", text: " but keep /review raw" },
    ]);
  });

  it("can decorate submitted Codex prompt tokens without a catalog", () => {
    const segments = decorateComposerText(
      "Run /prompts:review() and $create-pr but keep $schema $path raw",
      null,
      "codex",
      { decorateUnknownTokens: true },
    );

    expect(segments).toEqual([
      { kind: "text", text: "Run " },
      {
        kind: "prompt",
        text: "/prompts:review()",
        parts: [
          { text: "/prompts:review", tone: "base" },
          { text: "(", tone: "base" },
          { text: ")", tone: "base" },
        ],
        start: 4,
        end: 21,
      },
      { kind: "text", text: " and " },
      { kind: "skill", text: "$create-pr", start: 26, end: 36 },
      { kind: "text", text: " but keep $schema $path raw" },
    ]);
  });

  it("uses explicit mention bindings when decorating without a catalog", () => {
    const segments = decorateComposerText(
      "Use $github and $create-pr",
      null,
      "codex",
      {
        decorateUnknownTokens: true,
        mentionBindings: [
          { mention: "github", kind: "app", path: "app://github" },
          {
            mention: "create-pr",
            kind: "skill",
            path: "/tmp/create-pr/SKILL.md",
          },
        ],
      },
    );

    expect(segments).toEqual([
      { kind: "text", text: "Use " },
      { kind: "app", text: "$github", start: 4, end: 11 },
      { kind: "text", text: " and " },
      { kind: "skill", text: "$create-pr", start: 16, end: 26 },
    ]);
  });

  it("keeps trailing punctuation outside explicit dollar mention badges", () => {
    const segments = decorateComposerText("Use $github.", null, "codex", {
      decorateUnknownTokens: true,
      mentionBindings: [
        { mention: "github", kind: "app", path: "app://github" },
      ],
    });

    expect(segments).toEqual([
      { kind: "text", text: "Use " },
      { kind: "app", text: "$github", start: 4, end: 11 },
      { kind: "text", text: "." },
    ]);
  });

  it("keeps trailing punctuation outside unknown dollar mention badges", () => {
    const segments = decorateComposerText(
      "Use $code-simplifier.",
      null,
      "codex",
      { decorateUnknownTokens: true },
    );

    expect(segments).toEqual([
      { kind: "text", text: "Use " },
      { kind: "skill", text: "$code-simplifier", start: 4, end: 20 },
      { kind: "text", text: "." },
    ]);
  });

  it("decorates catalog-backed Claude command tokens without treating paths as commands", () => {
    const segments = decorateComposerText(
      "Run /review but leave /Users/test/file alone",
      {
        prompts: [
          {
            name: "review",
            description: "Review the current diff",
            argumentMode: "none",
            argumentNames: [],
            positionalCount: 0,
            argumentHint: null,
          },
        ],
        skills: [],
        apps: [],
      },
      "claude",
      { decorateUnknownTokens: true },
    );

    expect(segments).toEqual([
      { kind: "text", text: "Run " },
      {
        kind: "prompt",
        text: "/review",
        parts: [{ text: "/review", tone: "base" }],
        start: 4,
        end: 11,
      },
      { kind: "text", text: " but leave /Users/test/file alone" },
    ]);
  });

  it("decorates submitted single-word Claude commands without a catalog", () => {
    const segments = decorateComposerText(
      "Run /review",
      null,
      "claude",
      { decorateUnknownTokens: true },
    );

    expect(segments).toEqual([
      { kind: "text", text: "Run " },
      {
        kind: "prompt",
        text: "/review",
        parts: [{ text: "/review", tone: "base" }],
        start: 4,
        end: 11,
      },
    ]);
  });

  it("keeps trailing punctuation outside unknown slash command badges", () => {
    const segments = decorateComposerText(
      "Run /review. Then /release-notes:",
      null,
      "claude",
      { decorateUnknownTokens: true },
    );

    expect(segments).toEqual([
      { kind: "text", text: "Run " },
      {
        kind: "prompt",
        text: "/review",
        parts: [{ text: "/review", tone: "base" }],
        start: 4,
        end: 11,
      },
      { kind: "text", text: ". Then " },
      {
        kind: "prompt",
        text: "/release-notes",
        parts: [{ text: "/release-notes", tone: "base" }],
        start: 18,
        end: 32,
      },
      { kind: "text", text: ":" },
    ]);
  });

  it("can leave file mention text undecorated", () => {
    const segments = decorateComposerText("Ask @alice about @src/app.tsx", null, "codex", {
      decorateFileTokens: false,
    });

    expect(segments).toEqual([
      { kind: "text", text: "Ask @alice about @src/app.tsx" },
    ]);
  });

  it("can decorate submitted commands without relying on the current provider", () => {
    const segments = decorateComposerText(
      "Use /prompts:review() then /review and /release-notes but keep /workspace /run /mnt raw",
      null,
      "codex",
      { decorateAllProviderTokens: true, decorateUnknownTokens: true },
    );

    expect(segments).toEqual([
      { kind: "text", text: "Use " },
      {
        kind: "prompt",
        text: "/prompts:review()",
        parts: [
          { text: "/prompts:review", tone: "base" },
          { text: "(", tone: "base" },
          { text: ")", tone: "base" },
        ],
        start: 4,
        end: 21,
      },
      { kind: "text", text: " then " },
      {
        kind: "prompt",
        text: "/review",
        parts: [{ text: "/review", tone: "base" }],
        start: 27,
        end: 34,
      },
      { kind: "text", text: " and " },
      {
        kind: "prompt",
        text: "/release-notes",
        parts: [{ text: "/release-notes", tone: "base" }],
        start: 39,
        end: 53,
      },
      { kind: "text", text: " but keep /workspace /run /mnt raw" },
    ]);
  });

  it("finds the full decorated token range when deleting at the token edge", () => {
    expect(
      findComposerTokenDeletionRange(
        "Use $create-pr",
        "Use $create-pr".length,
        catalog,
        "codex",
      ),
    ).toEqual({ start: 4, end: 14 });
  });

  it("includes an appended token space when deleting at the trailing edge", () => {
    expect(
      findComposerTokenDeletionRange(
        "Use $create-pr ",
        "Use $create-pr ".length,
        catalog,
        "codex",
      ),
    ).toEqual({ start: 4, end: 15 });
  });

  it("does not delete a decorated prompt while editing inside its arguments", () => {
    const text = 'Use /prompts:review(topic="")';
    const cursorInsideArgument = text.indexOf('""') + 1;

    expect(
      findComposerTokenDeletionRange(
        text,
        cursorInsideArgument,
        {
          prompts: [
            {
              name: "review",
              description: "Review a topic",
              argumentMode: "named",
              argumentNames: ["topic"],
              positionalCount: 0,
              argumentHint: null,
            },
          ],
          skills: [],
          apps: [],
        },
        "codex",
      ),
    ).toBeNull();
  });

  it("builds Claude dollar suggestions without Codex mention bindings", () => {
    const token = findActiveComposerToken("Use $rev", 8, 8);
    const items = buildAutocompleteItems(
      token,
      {
        prompts: [],
        skills: [
          {
            name: "review",
            description: "Review the current diff",
            path: "/tmp/.claude/skills/review/SKILL.md",
          },
        ],
        apps: [],
      },
      [],
      "claude",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(
      expect.objectContaining({
        group: "Skills",
        insertText: "$review",
      }),
    );
    expect(items[0]).not.toHaveProperty("mentionBinding");
  });
});
