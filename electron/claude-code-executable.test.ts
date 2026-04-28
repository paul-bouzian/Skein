import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveClaudeCodeExecutablePath } from "./claude-code-executable";

const temporaryDirectories: string[] = [];

async function createTempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "skein-claude-code-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeClaudeBinary(
  resourcesPath: string,
  packageName: string,
  binaryName = "claude",
) {
  const path = join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    packageName,
    binaryName,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("resolveClaudeCodeExecutablePath", () => {
  it("uses the unpacked packaged Claude binary on macOS", async () => {
    const resourcesPath = await createTempDirectory();
    const claudePath = await writeClaudeBinary(
      resourcesPath,
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    );

    expect(
      resolveClaudeCodeExecutablePath({
        resourcesPath,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe(claudePath);
  });

  it("keeps an explicitly configured Claude binary path", async () => {
    expect(
      resolveClaudeCodeExecutablePath({
        explicitPath: " /opt/claude/bin/claude ",
        resourcesPath: "/unused",
      }),
    ).toBe("/opt/claude/bin/claude");
  });

  it("falls back to SDK discovery when no unpacked binary exists", async () => {
    expect(
      resolveClaudeCodeExecutablePath({
        resourcesPath: await createTempDirectory(),
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBeUndefined();
  });

  it("checks the Linux musl package before the generic package", async () => {
    const resourcesPath = await createTempDirectory();
    const claudePath = await writeClaudeBinary(
      resourcesPath,
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
    );

    expect(
      resolveClaudeCodeExecutablePath({
        resourcesPath,
        platform: "linux",
        arch: "x64",
      }),
    ).toBe(claudePath);
  });
});
