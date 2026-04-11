import { describe, expect, it } from "vitest";

import type { OpenTarget } from "../../lib/types";
import {
  matchesPersistedTargets,
  persistDraftTargets,
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
          command: "",
          argsText: "",
        },
        {
          draftKey: "draft-2",
          id: "open-target-draft-2",
          label: "Zed",
          kind: "app",
          appName: "Zed Beta",
          command: "",
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
          command: null,
          args: [],
        },
        {
          id: "zed-2",
          label: "Zed",
          kind: "app",
          appName: "Zed Beta",
          command: null,
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
        command: null,
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
            command: "",
            argsText: " --reuse-window \n",
          },
        ],
        "draft-1",
        persistedTargets,
        "cursor",
      ),
    ).toBe(true);
  });
});
