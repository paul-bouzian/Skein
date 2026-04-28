import { existsSync } from "node:fs";
import { join } from "node:path";

export type ClaudeCodeExecutableResolutionOptions = {
  readonly explicitPath?: string | null;
  readonly resourcesPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
};

export function resolveClaudeCodeExecutablePath({
  explicitPath,
  resourcesPath = readElectronResourcesPath(),
  platform = process.platform,
  arch = process.arch,
}: ClaudeCodeExecutableResolutionOptions = {}): string | undefined {
  const trimmedExplicitPath = explicitPath?.trim();
  if (trimmedExplicitPath) {
    return trimmedExplicitPath;
  }

  if (!resourcesPath) {
    return undefined;
  }

  const binaryName = platform === "win32" ? "claude.exe" : "claude";
  for (const packageName of claudeNativePackageNames(platform, arch)) {
    const candidate = join(
      resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      packageName,
      binaryName,
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function claudeNativePackageNames(platform: NodeJS.Platform, arch: string): string[] {
  if (platform === "linux") {
    return [
      `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
      `@anthropic-ai/claude-agent-sdk-linux-${arch}`,
    ];
  }

  return [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`];
}

function readElectronResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}
