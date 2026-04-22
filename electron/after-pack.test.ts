import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error electron-builder consumes this build hook as a JS module.
import afterPack from "../scripts/electron-after-pack.mjs";

const temporaryDirectories: string[] = [];

describe("electron afterPack", () => {
  afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("wraps the macOS launcher with the Fontations workaround", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skein-after-pack-"));
    temporaryDirectories.push(directory);

    const macOsDirectory = join(
      directory,
      "Skein.app",
      "Contents",
      "MacOS",
    );
    await mkdir(macOsDirectory, { recursive: true });
    const originalExecutablePath = join(macOsDirectory, "Skein");
    await writeFile(originalExecutablePath, "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });

    await afterPack({
      appOutDir: directory,
      electronPlatformName: "darwin",
      packager: {
        appInfo: {
          productFilename: "Skein",
        },
      },
    });

    const launcher = await readFile(originalExecutablePath, "utf8");
    expect(launcher).toContain("Skein-electron");
    expect(launcher).toContain("--disable-features=FontationsFontBackend");

    const wrappedExecutable = await readFile(
      join(macOsDirectory, "Skein-electron"),
      "utf8",
    );
    expect(wrappedExecutable).toContain("exit 0");

    const mode = (await stat(originalExecutablePath)).mode & 0o777;
    expect(mode).toBe(0o755);
  });
});
