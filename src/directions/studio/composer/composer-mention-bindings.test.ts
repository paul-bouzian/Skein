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
});
