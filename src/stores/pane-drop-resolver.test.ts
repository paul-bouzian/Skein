import { describe, expect, it } from "vitest";

import { resolvePaneDrop } from "./pane-drop-resolver";
import type { PaneSelection, SlotKey } from "./workspace-store";

function makePane(id: string): PaneSelection {
  return {
    projectId: "project",
    environmentId: "env",
    threadId: id,
  };
}

function emptySlots(): Record<SlotKey, PaneSelection | null> {
  return {
    topLeft: null,
    topRight: null,
    bottomLeft: null,
    bottomRight: null,
  };
}

describe("resolvePaneDrop", () => {
  it("creates the initial pane when the layout is empty", () => {
    const plan = resolvePaneDrop(emptySlots(), 0.5, 0.5, 0.3, 0.3);
    expect(plan).not.toBeNull();
    expect(plan?.newSlot).toBe("topLeft");
    expect(plan?.previewRect).toEqual({
      left: 0,
      top: 0,
      width: 1,
      height: 1,
    });
  });

  it("splits a single pane vertically when dropping on the top edge", () => {
    const slots = { ...emptySlots(), topLeft: makePane("a") };
    const plan = resolvePaneDrop(slots, 0.5, 0.5, 0.5, 0.05);
    expect(plan?.newSlot).toBe("topLeft");
    expect(plan?.direction).toBe("top");
    expect(plan?.previewRect).toEqual({
      left: 0,
      top: 0,
      width: 1,
      height: 0.5,
    });
  });

  it("returns null when hovering over a filled top row with no empty slot", () => {
    // 3 panes: TL, TR filled, BL filled, BR null.
    const slots = {
      topLeft: makePane("a"),
      topRight: makePane("b"),
      bottomLeft: makePane("c"),
      bottomRight: null,
    };
    // Cursor anywhere over the top row should reject (both top slots filled
    // and dropping above top row is not supported).
    const plan = resolvePaneDrop(slots, 0.5, 0.5, 0.3, 0.1);
    expect(plan).toBeNull();
  });

  it("splits the spanning bottom pane to the left half", () => {
    const slots = {
      topLeft: makePane("a"),
      topRight: makePane("b"),
      bottomLeft: makePane("c"),
      bottomRight: null,
    };
    // Cursor in the left half of the bottom row (the spanning pane).
    const plan = resolvePaneDrop(slots, 0.5, 0.5, 0.1, 0.8);
    expect(plan?.newSlot).toBe("bottomLeft");
    expect(plan?.direction).toBe("left");
    // Existing BL pane shifts to BR.
    expect(plan?.updates).toEqual([
      { slot: "bottomRight", value: makePane("c") },
    ]);
    // Preview is the bottom-left quarter in the post-drop layout.
    expect(plan?.previewRect.left).toBe(0);
    expect(plan?.previewRect.width).toBe(0.5);
    expect(plan?.previewRect.top).toBe(0.5);
    expect(plan?.previewRect.height).toBe(0.5);
  });

  it("splits the spanning bottom pane to the right half", () => {
    const slots = {
      topLeft: makePane("a"),
      topRight: makePane("b"),
      bottomLeft: makePane("c"),
      bottomRight: null,
    };
    const plan = resolvePaneDrop(slots, 0.5, 0.5, 0.9, 0.8);
    expect(plan?.newSlot).toBe("bottomRight");
    expect(plan?.direction).toBe("right");
    expect(plan?.updates).toEqual([]);
    expect(plan?.previewRect).toEqual({
      left: 0.5,
      top: 0.5,
      width: 0.5,
      height: 0.5,
    });
  });

  it("rejects drops in directions that would duplicate an occupied slot", () => {
    // Layout TL only: drop "right" over TL should go to TR. But if TR is
    // filled (2-pane row) and cursor is over TL, drop "right" on TL's right
    // edge would target TR which is already taken — expect rejection.
    const slots = {
      topLeft: makePane("a"),
      topRight: makePane("b"),
      bottomLeft: null,
      bottomRight: null,
    };
    // Cursor near the right edge of TL's rect (TL goes from x=0 to x=0.5).
    const plan = resolvePaneDrop(slots, 0.5, 0.5, 0.48, 0.5);
    expect(plan).toBeNull();
  });

  it("returns null when 4 panes are already placed", () => {
    const slots = {
      topLeft: makePane("a"),
      topRight: makePane("b"),
      bottomLeft: makePane("c"),
      bottomRight: makePane("d"),
    };
    const plan = resolvePaneDrop(slots, 0.5, 0.5, 0.5, 0.5);
    expect(plan).toBeNull();
  });
});
