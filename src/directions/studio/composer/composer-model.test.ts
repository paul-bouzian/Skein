import { describe, expect, it } from "vitest";

import type { ThreadComposerCatalog } from "../../../lib/types";
import {
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
});
