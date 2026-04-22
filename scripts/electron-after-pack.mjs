#!/usr/bin/env node

import { chmod, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FONTATIONS_DISABLE_FLAG = "--disable-features=FontationsFontBackend";
const WRAPPED_EXECUTABLE_SUFFIX = "-electron";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const macOsDirectory = join(
    context.appOutDir,
    `${appName}.app`,
    "Contents",
    "MacOS",
  );
  const launcherPath = join(macOsDirectory, appName);
  const wrappedExecutableName = `${appName}${WRAPPED_EXECUTABLE_SUFFIX}`;
  const wrappedExecutablePath = join(macOsDirectory, wrappedExecutableName);

  await rename(launcherPath, wrappedExecutablePath);
  await writeFile(
    launcherPath,
    createLauncherScript(wrappedExecutableName),
    { mode: 0o755 },
  );
  await chmod(launcherPath, 0o755);
}

function createLauncherScript(wrappedExecutableName) {
  return `#!/bin/sh
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$SCRIPT_DIR/${wrappedExecutableName}" ${FONTATIONS_DISABLE_FLAG} "$@"
`;
}
