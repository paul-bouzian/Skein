import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const distDirectory = join(process.cwd(), "dist-electron");
const distPackagePath = join(distDirectory, "package.json");

await mkdir(distDirectory, { recursive: true });
await writeFile(
  distPackagePath,
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
  "utf8",
);
