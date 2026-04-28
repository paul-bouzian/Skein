import { describe, expect, it } from "vitest";

import { parseReleaseNotes } from "./release-notes-parser";

describe("ReleaseNotesCard release note parsing", () => {
  it("keeps markdown release notes structured for display", () => {
    expect(
      parseReleaseNotes(`<!-- Release notes generated using configuration in .github/release.yml at v0.1.30 -->

## What's Changed

- feat: add native updates by @paul-bouzian in #123
- fix: render notes by @paul-bouzian in https://github.com/paul-bouzian/Skein/pull/124

**Full Changelog**: https://github.com/paul-bouzian/Skein/compare/v0.1.29...v0.1.30`),
    ).toEqual([
      { kind: "heading", text: "What's Changed" },
      {
        kind: "list",
        items: ["feat: add native updates", "fix: render notes"],
      },
    ]);
  });

  it("normalizes GitHub HTML release notes before parsing", () => {
    expect(
      parseReleaseNotes(`<h2>What's Changed</h2>
<ul>
  <li>fix: package mac auto-update config by <a href="https://github.com/paul-bouzian">@paul-bouzian</a> in <a href="https://github.com/paul-bouzian/Skein/pull/99">#99</a></li>
</ul>
<p><strong>Full Changelog</strong>: <a class="commit-link" href="https://github.com/paul-bouzian/Skein/compare/v0.1.29...v0.1.30"><tt>v0.1.29...v0.1.30</tt></a></p>`),
    ).toEqual([
      { kind: "heading", text: "What's Changed" },
      {
        kind: "list",
        items: ["fix: package mac auto-update config"],
      },
    ]);
  });
});
