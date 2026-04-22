import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type PreferencesSnapshot = Record<string, string>;

function parsePreferencesFile(path: string): PreferencesSnapshot {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export class PreferencesStore {
  private readonly path: string;
  private snapshot: PreferencesSnapshot;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
    this.snapshot = parsePreferencesFile(path);
  }

  getSnapshot(): PreferencesSnapshot {
    return { ...this.snapshot };
  }

  async set(key: string, value: string | null) {
    const writeTask = this.writeChain.then(
      () => this.applyAndPersist(key, value),
      () => this.applyAndPersist(key, value),
    );
    this.writeChain = writeTask.then(
      () => undefined,
      () => undefined,
    );
    return writeTask;
  }

  private async applyAndPersist(key: string, value: string | null) {
    const previousSnapshot = this.getSnapshot();
    if (value === null) {
      delete this.snapshot[key];
    } else {
      this.snapshot[key] = value;
    }

    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(
        this.path,
        `${JSON.stringify(this.snapshot, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      this.snapshot = previousSnapshot;
      throw error;
    }
  }
}
