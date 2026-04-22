import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PreferencesStore } from "./preferences.js";

const temporaryDirectories: string[] = [];

async function createTempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "skein-preferences-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("PreferencesStore", () => {
  it("persists preferences to disk", async () => {
    const directory = await createTempDirectory();
    const path = join(directory, "ui-prefs.json");
    const store = new PreferencesStore(path);

    await store.set("skein.theme", "dark");

    expect(store.getSnapshot()).toEqual({
      "skein.theme": "dark",
    });
    await expect(readFile(path, "utf8")).resolves.toContain("\"skein.theme\": \"dark\"");
  });

  it("rolls back failed writes and recovers the queue for later writes", async () => {
    const directory = await createTempDirectory();
    const path = join(directory, "ui-prefs.json");
    const store = new PreferencesStore(path);

    await chmod(directory, 0o500);
    await expect(store.set("skein.theme", "dark")).rejects.toThrow();
    expect(store.getSnapshot()).toEqual({});

    await chmod(directory, 0o700);
    await expect(store.set("skein.theme", "light")).resolves.toBeUndefined();
    expect(store.getSnapshot()).toEqual({
      "skein.theme": "light",
    });
    await expect(readFile(path, "utf8")).resolves.toContain("\"skein.theme\": \"light\"");
  });
});
