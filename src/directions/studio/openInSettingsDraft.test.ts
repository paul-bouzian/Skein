import { describe, expect, it } from "vitest";

import type { OpenTarget } from "../../lib/types";
import {
  matchesPersistedTargets,
  persistDraftTargets,
  toPersistedTarget,
  type OpenInDraftState,
} from "./openInSettingsDraft";

describe("openInSettingsDraft", () => {
  it("preserves the selected default when finalized ids are deduplicated", () => {
    const state: OpenInDraftState = {
      targets: [
        {
          draftKey: "draft-1",
          id: "open-target-draft-1",
          label: "Zed",
          kind: "app",
          appName: "Zed",
          argsText: "",
        },
        {
          draftKey: "draft-2",
          id: "open-target-draft-2",
          label: "Zed",
          kind: "app",
          appName: "Zed Beta",
          argsText: "",
        },
      ],
      defaultDraftKey: "draft-2",
    };

    expect(persistDraftTargets(state)).toEqual({
      openTargets: [
        {
          id: "zed",
          label: "Zed",
          kind: "app",
          appName: "Zed",
          args: [],
        },
        {
          id: "zed-2",
          label: "Zed",
          kind: "app",
          appName: "Zed Beta",
          args: [],
        },
      ],
      defaultOpenTargetId: "zed-2",
    });
  });

  it("compares the finalized payload when checking for local changes", () => {
    const persistedTargets: OpenTarget[] = [
      {
        id: "cursor",
        label: "Cursor",
        kind: "app",
        appName: "Cursor",
        args: ["--reuse-window"],
      },
    ];

    expect(
      matchesPersistedTargets(
        [
          {
            draftKey: "draft-1",
            id: " cursor ",
            label: " Cursor ",
            kind: "app",
            appName: " Cursor ",
            argsText: " --reuse-window \n",
          },
        ],
        "draft-1",
        persistedTargets,
        "cursor",
      ),
    ).toBe(true);
  });

  it("drops inactive app fields when serializing a file manager target", () => {
    expect(
      toPersistedTarget({
        draftKey: "draft-1",
        id: "finder",
        label: "Finder",
        kind: "fileManager",
        appName: "Cursor",
        argsText: "--reuse-window",
      }),
    ).toEqual({
      id: "finder",
      label: "Finder",
      kind: "fileManager",
      appName: null,
      args: [],
    });

    expect(
      toPersistedTarget({
        draftKey: "draft-2",
        id: "cursor",
        label: "Cursor",
        kind: "app",
        appName: "Cursor",
        argsText: "",
      }),
    ).toEqual({
      id: "cursor",
      label: "Cursor",
      kind: "app",
      appName: "Cursor",
      args: [],
    });
  });
});
