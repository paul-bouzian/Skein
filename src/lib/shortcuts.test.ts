import { describe, expect, it } from "vitest";

import {
  buildShortcutValue,
  isMacPlatform,
  matchesShortcut,
  parseShortcut,
} from "./shortcuts";

function primaryModifier() {
  return isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
}

describe("shortcuts helpers", () => {
  it("parses normalized shortcuts with whitespace and casing differences", () => {
    expect(parseShortcut("  Mod + Shift + ,  ")).toEqual({
      key: "comma",
      meta: false,
      ctrl: false,
      alt: false,
      shift: true,
      mod: true,
    });
  });

  it("rejects invalid shortcut inputs", () => {
    expect(parseShortcut("")).toBeNull();
    expect(parseShortcut("ctrl+alt")).toBeNull();
    expect(parseShortcut("ctrl+a+b")).toBeNull();
    expect(parseShortcut("a")).toBeNull();
    expect(parseShortcut("shift+a")).toBeNull();
  });

  it("keeps the Shift+Tab exception", () => {
    expect(parseShortcut("shift+tab")).toEqual({
      key: "tab",
      meta: false,
      ctrl: false,
      alt: false,
      shift: true,
      mod: false,
    });
  });

  it("normalizes shifted bracket keys so default thread shortcuts match browser events", () => {
    const event = new KeyboardEvent("keydown", {
      key: "}",
      shiftKey: true,
      ...primaryModifier(),
    });

    expect(matchesShortcut(event, "mod+shift+]")).toBe(true);
  });

  it("serializes the plus key with an unambiguous token", () => {
    const event = new KeyboardEvent("keydown", {
      key: "+",
      shiftKey: true,
      ...primaryModifier(),
    });

    expect(buildShortcutValue(event)).toBe("mod+shift+plus");
    expect(parseShortcut("mod+shift+plus")?.key).toBe("plus");
  });
});
