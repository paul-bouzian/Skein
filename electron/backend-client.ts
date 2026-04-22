import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

type BackendRequest = {
  type: "request";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type BackendResponse = {
  type: "response";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: {
    message: string;
  };
};

type BackendEvent = {
  type: "event";
  name: string;
  payload: unknown;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type BackendClientOptions = {
  appDataDir: string;
  homeDir: string;
  onEvent(eventName: string, payload: unknown): void;
};

function resolveBackendBinaryPath() {
  if (process.env.SKEIN_BACKEND_BIN?.trim()) {
    return process.env.SKEIN_BACKEND_BIN.trim();
  }

  if (app.isPackaged) {
    return join(process.resourcesPath, "bin", "skein-backend");
  }

  const projectRoot = join(__dirname, "..", "..");
  return join(projectRoot, "desktop-backend", "target", "debug", "skein-backend");
}

function describeBackendExit(code: number | null, signal: NodeJS.Signals | null) {
  if (signal) {
    return `Backend sidecar exited with signal ${signal}.`;
  }
  if (code === null) {
    return "Backend sidecar exited unexpectedly.";
  }
  return `Backend sidecar exited with code ${code}.`;
}

export class BackendClient {
  private readonly options: BackendClientOptions;
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(options: BackendClientOptions) {
    this.options = options;
  }

  async start() {
    if (this.process) {
      return;
    }

    const backendPath = resolveBackendBinaryPath();
    const child = spawn(
      backendPath,
      [
        "--app-data-dir",
        this.options.appDataDir,
        "--home-dir",
        this.options.homeDir,
      ],
      {
        stdio: "pipe",
      },
    );
    this.process = child;

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      this.handleLine(line);
    });

    child.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.options.onEvent("skein://backend-state", {
          state: "stderr",
          message,
        });
      }
    });

    child.on("error", (error) => {
      this.failAllPending(error.message);
      this.options.onEvent("skein://backend-state", {
        state: "failed",
        message: error.message,
      });
      this.process = null;
    });

    child.on("exit", (code, signal) => {
      const message = describeBackendExit(code, signal);
      this.failAllPending(message);
      this.options.onEvent("skein://backend-state", {
        state: "disconnected",
        message,
      });
      this.process = null;
    });
  }

  async stop() {
    if (!this.process) {
      return;
    }

    const child = this.process;
    this.process = null;
    child.kill("SIGTERM");
  }

  async invoke<T>(command: string, payload?: Record<string, unknown>) {
    if (!this.process) {
      throw new Error("Backend sidecar is not running.");
    }

    const id = this.nextRequestId++;
    const request: BackendRequest = {
      type: "request",
      id,
      method: command,
      params: payload,
    };

    const responsePromise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.process.stdin.write(`${JSON.stringify(request)}\n`);
    return responsePromise;
  }

  private handleLine(line: string) {
    const message = line.trim();
    if (!message) {
      return;
    }

    let parsed: BackendResponse | BackendEvent;
    try {
      parsed = JSON.parse(message) as BackendResponse | BackendEvent;
    } catch (error) {
      this.options.onEvent("skein://backend-state", {
        state: "invalid-message",
        message: error instanceof Error ? error.message : String(error),
        raw: message,
      });
      return;
    }

    if (parsed.type === "event") {
      this.options.onEvent(parsed.name, parsed.payload);
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }
    this.pending.delete(parsed.id);

    if (!parsed.ok) {
      pending.reject(new Error(parsed.error?.message ?? "Unknown backend error."));
      return;
    }

    pending.resolve(parsed.result);
  }

  private failAllPending(message: string) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error(message));
    }
  }
}
