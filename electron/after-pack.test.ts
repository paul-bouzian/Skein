import { describe, expect, it } from "vitest";

describe("electron afterPack", () => {
  it("creates a native launcher that injects launch-time compatibility switches", async () => {
    const modulePath = "../scripts/electron-after-pack.mjs";
    const { createLauncherSource } = await import(modulePath);
    const source = createLauncherSource({
      fontationsDisableFlag: "--disable-features=FontationsFontBackend",
      jitlessFlag: "--js-flags=--jitless",
    });

    expect(source).toContain("int ElectronMain(int argc, char* argv[]);");
    expect(source).toContain('unsetenv("ELECTRON_RUN_AS_NODE");');
    expect(source).toContain(
      'patched_argv[next_argument_index] = "--disable-features=FontationsFontBackend";',
    );
    expect(source).toContain('patched_argv[next_argument_index] = "--js-flags=--jitless";');
    expect(source).toContain("argument_disables_fontations");
    expect(source).toContain("current_macos_requires_jitless");
    expect(source).toContain(
      "int result = ElectronMain((int)((size_t)argc + injected_argument_count), patched_argv);",
    );
  });

  it("builds the launcher with Electron Framework on the runtime rpath", async () => {
    const modulePath = "../scripts/electron-after-pack.mjs";
    const { createLauncherBuildArgs } = await import(modulePath);
    const args = createLauncherBuildArgs({
      frameworksDirectory: "/tmp/Skein.app/Contents/Frameworks",
      launcherPath: "/tmp/Skein.app/Contents/MacOS/Skein",
      launcherSourcePath: "/tmp/Skein.app/Contents/MacOS/skein-electron-launcher.c",
    });

    expect(args).toEqual([
      "clang",
      "/tmp/Skein.app/Contents/MacOS/skein-electron-launcher.c",
      "-F",
      "/tmp/Skein.app/Contents/Frameworks",
      "-framework",
      "Electron Framework",
      "-Wl,-rpath,@executable_path/../Frameworks",
      "-o",
      "/tmp/Skein.app/Contents/MacOS/Skein",
    ]);
  });
});
