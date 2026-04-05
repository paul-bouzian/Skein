import { describe, expect, it } from "vitest";

import {
  addComposerMentionBinding,
  prepareComposerMentionBindingsForSend,
  rebaseComposerMentionBindings,
} from "./composer-mention-bindings";
import type { ComposerAutocompleteItem } from "./composer-model";

describe("composer-mention-bindings", () => {
  it("rebases mention bindings after edits before the token", () => {
    const bindings = [
      {
        mention: "github",
        kind: "app" as const,
        path: "app://github",
        start: 4,
        end: 11,
      },
    ];

    expect(
      rebaseComposerMentionBindings("Use $github", "Please use $github", bindings),
    ).toEqual([
      {
        mention: "github",
        kind: "app",
        path: "app://github",
        start: 11,
        end: 18,
      },
    ]);
  });

  it("drops stale bindings once the token text changes", () => {
    const bindings = [
      {
        mention: "github",
        kind: "app" as const,
        path: "app://github",
        start: 4,
        end: 11,
      },
    ];

    expect(
      prepareComposerMentionBindingsForSend(
        "Use $github-app",
        rebaseComposerMentionBindings("Use $github", "Use $github-app", bindings),
      ),
    ).toEqual([]);
  });

  it("keeps bindings when the token casing changes", () => {
    const bindings = [
      {
        mention: "github",
        kind: "app" as const,
        path: "app://github",
        start: 4,
        end: 11,
      },
    ];

    expect(
      prepareComposerMentionBindingsForSend(
        "Use $GitHub",
        rebaseComposerMentionBindings("Use $github", "Use $GitHub", bindings),
      ),
    ).toEqual([
      {
        mention: "github",
        kind: "app",
        path: "app://github",
      },
    ]);
  });

  it("keeps bindings when the last token character changes casing", () => {
    const bindings = [
      {
        mention: "github",
        kind: "app" as const,
        path: "app://github",
        start: 4,
        end: 11,
      },
    ];

    expect(
      prepareComposerMentionBindingsForSend(
        "Use $github",
        rebaseComposerMentionBindings("Use $githuB", "Use $github", bindings),
      ),
    ).toEqual([
      {
        mention: "github",
        kind: "app",
        path: "app://github",
      },
    ]);
  });

  it("adds autocomplete-selected bindings at the inserted token range", () => {
    const item: ComposerAutocompleteItem = {
      id: "app:github",
      group: "Apps",
      label: "github",
      insertText: "$github",
      appendSpace: true,
      mentionBinding: {
        mention: "github",
        kind: "app",
        path: "app://github",
      },
    };

    expect(addComposerMentionBinding([], item, 4)).toEqual([
      {
        mention: "github",
        kind: "app",
        path: "app://github",
        start: 4,
        end: 11,
      },
    ]);
  });

  it("replaces an existing binding at the same token range", () => {
    const skillItem: ComposerAutocompleteItem = {
      id: "skill:github",
      group: "Skills",
      label: "github",
      insertText: "$github",
      appendSpace: true,
      mentionBinding: {
        mention: "github",
        kind: "skill",
        path: "/tmp/threadex/.codex/skills/github/SKILL.md",
      },
    };
    const appItem: ComposerAutocompleteItem = {
      id: "app:github",
      group: "Apps",
      label: "github",
      insertText: "$github",
      appendSpace: true,
      mentionBinding: {
        mention: "github",
        kind: "app",
        path: "app://github",
      },
    };

    expect(
      addComposerMentionBinding(addComposerMentionBinding([], skillItem, 4), appItem, 4),
    ).toEqual([
      {
        mention: "github",
        kind: "app",
        path: "app://github",
        start: 4,
        end: 11,
      },
    ]);
  });
});
