import { describe, expect, it } from "vitest";

import type { ThreadComposerCatalog } from "../../../lib/types";
import {
  buildAutocompleteItems,
  decorateComposerText,
  findActiveComposerToken,
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

  it("builds Claude slash suggestions from commands and skills", () => {
    const token = findActiveComposerToken("/rev", 4, 4);
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
        group: "Skills",
        label: "/review",
        insertText: "/review",
      }),
    ]);
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
