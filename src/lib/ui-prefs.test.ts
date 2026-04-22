import { beforeEach, describe, expect, it } from "vitest";
import {
  preferenceSetMock,
  setDesktopPreferenceSnapshot,
} from "../test/desktop-mock";

import {
  persistUiPreference,
  readUiPreferenceWithMigration,
} from "./ui-prefs";

function createLocalStorageStub() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  } as Storage;
}

describe("ui-prefs", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createLocalStorageStub(),
    });
    setDesktopPreferenceSnapshot({});
  });

  it("reads the current desktop preference snapshot via the bridge getter", () => {
    setDesktopPreferenceSnapshot({
      "skein.theme": "dark",
    });

    expect(
      readUiPreferenceWithMigration("skein.theme", "legacy.theme"),
    ).toBe("dark");
    expect(localStorage.getItem("skein.theme")).toBe("dark");
  });

  it("persists preferences locally and mirrors them to the desktop host", async () => {
    await persistUiPreference("skein.theme", "light");

    expect(localStorage.getItem("skein.theme")).toBe("light");
    expect(preferenceSetMock).toHaveBeenCalledWith("skein.theme", "light");
  });
});
