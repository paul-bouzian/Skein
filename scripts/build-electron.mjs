#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { build, context } from "esbuild";

const watchMode = process.argv.includes("--watch");
const buildTargets = [
  {
    entryPoint: resolve("electron/main.ts"),
    outfile: resolve("dist-electron/electron/main.js"),
  },
  {
    entryPoint: resolve("electron/preload.ts"),
    outfile: resolve("dist-electron/electron/preload.js"),
  },
];

const sharedOptions = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
};

await mkdir(dirname(buildTargets[0].outfile), { recursive: true });

if (watchMode) {
  const contexts = await Promise.all(
    buildTargets.map((target) =>
      context({
        ...sharedOptions,
        entryPoints: [target.entryPoint],
        outfile: target.outfile,
      }),
    ),
  );
  await Promise.all(contexts.map((buildContext) => buildContext.watch()));
  await new Promise(() => {});
} else {
  await Promise.all(
    buildTargets.map((target) =>
      build({
        ...sharedOptions,
        entryPoints: [target.entryPoint],
        outfile: target.outfile,
      }),
    ),
  );
}
