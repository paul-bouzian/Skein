import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import { TerminalView } from "./TerminalView";

let latestOnData: ((data: string) => void) | null = null;
let latestResizeObserverTrigger: (() => void) | null = null;
let latestFitSpy: ReturnType<typeof vi.fn> | null = null;

class MockResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    latestResizeObserverTrigger = () => {
      callback([] as ResizeObserverEntry[], {} as ResizeObserver);
    };
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn((callback: (data: string) => void) => {
      latestOnData = callback;
      return { dispose: vi.fn() };
    });
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = vi.fn(() => {});

    constructor() {
      latestFitSpy = this.fit;
    }
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(),
}));

vi.mock("../../lib/bridge", () => ({
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  writeTerminal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/terminal-output-bus", () => ({
  subscribeToTerminalOutput: vi.fn(() => () => {}),
}));

const mockedBridge = vi.mocked(bridge);

beforeEach(() => {
  vi.clearAllMocks();
  latestOnData = null;
  latestResizeObserverTrigger = null;
  latestFitSpy = null;
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLDivElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 320,
  });
  Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 180,
  });
});

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TerminalView", () => {
  it("stops forwarding input and resize after a not_found write failure", async () => {
    mockedBridge.writeTerminal.mockRejectedValueOnce({
      code: "not_found",
      message: "terminal session not found",
    });

    render(<TerminalView ptyId="pty-1" active={false} exited={false} />);
    await flushEffects();

    expect(mockedBridge.resizeTerminal).toHaveBeenCalledTimes(1);
    expect(latestFitSpy).toHaveBeenCalledTimes(1);

    latestOnData?.("pwd\n");
    await flushEffects();
    expect(mockedBridge.writeTerminal).toHaveBeenCalledTimes(1);

    latestOnData?.("ls\n");
    latestResizeObserverTrigger?.();
    await flushEffects();

    expect(mockedBridge.writeTerminal).toHaveBeenCalledTimes(1);
    expect(mockedBridge.resizeTerminal).toHaveBeenCalledTimes(1);
    expect(latestFitSpy).toHaveBeenCalledTimes(2);
  });
});
