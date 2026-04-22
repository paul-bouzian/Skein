#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { normalizeVersion, validateVersion } from "./lib/release-version.mjs";

const version = normalizeVersion(process.argv[2] ?? "");
validateVersion(version);

const packageJsonPath = resolve("package.json");
const cargoTomlPath = resolve("desktop-backend/Cargo.toml");

const [packageJsonRaw, cargoTomlRaw] = await Promise.all([
  readFile(packageJsonPath, "utf8"),
  readFile(cargoTomlPath, "utf8"),
]);

const packageJson = JSON.parse(packageJsonRaw);
packageJson.version = version;

const nextCargoToml = updateCargoPackageVersion(cargoTomlRaw, version);

await Promise.all([
  writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`),
  writeFile(cargoTomlPath, nextCargoToml),
]);

function updateCargoPackageVersion(cargoToml, nextVersion) {
  const lines = cargoToml.split("\n");
  let insidePackage = false;
  let replaced = false;

  const nextLines = lines.map((line) => {
    if (line.trim() === "[package]") {
      insidePackage = true;
      return line;
    }

    if (insidePackage && line.startsWith("[")) {
      insidePackage = false;
    }

    if (insidePackage && line.startsWith("version = ")) {
      replaced = true;
      return `version = "${nextVersion}"`;
    }

    return line;
  });

  if (!replaced) {
    throw new Error("Failed to locate package version in desktop-backend/Cargo.toml");
  }

  return `${nextLines.join("\n").replace(/\n?$/, "\n")}`;
}
