import { describe, expect, it } from "vitest";

import { makeGlobalSettings } from "../test/fixtures/conversation";
import {
  defaultDraftThreadState,
  persistedDraftThreadState,
} from "./draft-threads";

describe("draft thread defaults", () => {
  const projectTarget = { kind: "project", projectId: "project-1" } as const;

  it("defaults project drafts to the local environment", () => {
    const state = defaultDraftThreadState(projectTarget, makeGlobalSettings());

    expect(state.projectSelection).toEqual({ kind: "local" });
  });

  it("can default project drafts to a new worktree", () => {
    const settings = makeGlobalSettings({
      defaultDraftEnvironment: "newWorktree",
    });

    const state = defaultDraftThreadState(projectTarget, settings);

    expect(state.projectSelection).toEqual({
      kind: "new",
      baseBranch: "",
      name: "",
    });
    expect(persistedDraftThreadState(projectTarget, state, settings)).toBeNull();
  });
});
