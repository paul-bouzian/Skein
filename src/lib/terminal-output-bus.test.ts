import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalOutputPayload } from "./bridge";

const listenMock = vi.fn();

vi.mock("./bridge", () => ({
  listenToTerminalOutput: (
    callback: (payload: TerminalOutputPayload) => void,
  ) => listenMock(callback),
}));

async function loadBus() {
  return await import("./terminal-output-bus");
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

beforeEach(async () => {
  vi.resetModules();
  listenMock.mockReset();
  listenMock.mockResolvedValue(() => {});
});

afterEach(async () => {
  const bus = await loadBus();
  bus.__resetTerminalOutputBus();
});

describe("terminal-output-bus", () => {
  it("replays buffered output that arrives before a subscriber is attached", async () => {
    let emit!: (payload: TerminalOutputPayload) => void;
    listenMock.mockImplementation(async (callback) => {
      emit = callback;
      return () => {};
    });

    const bus = await loadBus();
    await bus.ensureTerminalOutputBusReady();

    emit({ ptyId: "pty-1", dataBase64: encodeBase64("hello ") });
    emit({ ptyId: "pty-1", dataBase64: encodeBase64("world") });

    const received: string[] = [];
    bus.subscribeToTerminalOutput("pty-1", (bytes) => {
      received.push(bytesToString(bytes));
    });

    expect(received.join("")).toBe("hello world");
  });

  it("replays prior output again after a subscriber disconnects and remounts", async () => {
    let emit!: (payload: TerminalOutputPayload) => void;
    listenMock.mockImplementation(async (callback) => {
      emit = callback;
      return () => {};
    });

    const bus = await loadBus();
    await bus.ensureTerminalOutputBusReady();

    const firstReceived: string[] = [];
    const unlisten = bus.subscribeToTerminalOutput("pty-1", (bytes) => {
      firstReceived.push(bytesToString(bytes));
    });

    emit({ ptyId: "pty-1", dataBase64: encodeBase64("hello") });
    emit({ ptyId: "pty-1", dataBase64: encodeBase64(" world") });
    expect(firstReceived.join("")).toBe("hello world");

    unlisten();

    const secondReceived: string[] = [];
    bus.subscribeToTerminalOutput("pty-1", (bytes) => {
      secondReceived.push(bytesToString(bytes));
    });

    expect(secondReceived.join("")).toBe("hello world");
  });

  it("routes subsequent output directly to the active subscriber", async () => {
    let emit!: (payload: TerminalOutputPayload) => void;
    listenMock.mockImplementation(async (callback) => {
      emit = callback;
      return () => {};
    });

    const bus = await loadBus();
    await bus.ensureTerminalOutputBusReady();

    const received: string[] = [];
    bus.subscribeToTerminalOutput("pty-1", (bytes) => {
      received.push(bytesToString(bytes));
    });

    emit({ ptyId: "pty-1", dataBase64: encodeBase64("live output") });
    expect(received).toContain("live output");
  });

  it("does not deliver output for one ptyId to a subscriber for another", async () => {
    let emit!: (payload: TerminalOutputPayload) => void;
    listenMock.mockImplementation(async (callback) => {
      emit = callback;
      return () => {};
    });

    const bus = await loadBus();
    await bus.ensureTerminalOutputBusReady();

    const received1: string[] = [];
    const received2: string[] = [];
    bus.subscribeToTerminalOutput("pty-1", (bytes) =>
      received1.push(bytesToString(bytes)),
    );
    bus.subscribeToTerminalOutput("pty-2", (bytes) =>
      received2.push(bytesToString(bytes)),
    );

    emit({ ptyId: "pty-1", dataBase64: encodeBase64("one") });
    emit({ ptyId: "pty-2", dataBase64: encodeBase64("two") });

    expect(received1).toEqual(["one"]);
    expect(received2).toEqual(["two"]);
  });

  it("dropPendingTerminalOutput clears buffered output for a ptyId", async () => {
    let emit!: (payload: TerminalOutputPayload) => void;
    listenMock.mockImplementation(async (callback) => {
      emit = callback;
      return () => {};
    });

    const bus = await loadBus();
    await bus.ensureTerminalOutputBusReady();

    emit({ ptyId: "pty-1", dataBase64: encodeBase64("orphan") });
    bus.dropPendingTerminalOutput("pty-1");

    const received: string[] = [];
    bus.subscribeToTerminalOutput("pty-1", (bytes) =>
      received.push(bytesToString(bytes)),
    );
    expect(received).toEqual([]);
  });

  it("ensureTerminalOutputBusReady attaches the underlying listener only once", async () => {
    listenMock.mockImplementation(async () => () => {});

    const bus = await loadBus();
    await bus.ensureTerminalOutputBusReady();
    await bus.ensureTerminalOutputBusReady();
    await bus.ensureTerminalOutputBusReady();

    expect(listenMock).toHaveBeenCalledTimes(1);
  });

  it("retries listener attachment after an initial failure", async () => {
    let attempts = 0;
    listenMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("attach failed");
      }
      return () => {};
    });

    const bus = await loadBus();

    await expect(bus.ensureTerminalOutputBusReady()).rejects.toThrow(
      "attach failed",
    );
    await expect(bus.ensureTerminalOutputBusReady()).resolves.toBeUndefined();

    expect(listenMock).toHaveBeenCalledTimes(2);
  });
});
