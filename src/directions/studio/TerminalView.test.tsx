import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import { TerminalView } from "./TerminalView";

type ThemeMode = "dark" | "light";

const TERMINAL_CSS_VARS = {
  dark: {
    "--tx-terminal-background": "#0e0f12",
    "--tx-terminal-foreground": "#e7e8ec",
    "--tx-terminal-cursor": "#ef4444",
    "--tx-terminal-cursor-accent": "#0e0f12",
    "--tx-terminal-selection": "rgba(239, 68, 68, 0.24)",
    "--tx-terminal-selection-inactive": "rgba(239, 68, 68, 0.16)",
    "--tx-terminal-selection-foreground": "#f7f7fb",
    "--tx-terminal-black": "#2d333b",
    "--tx-terminal-red": "#f47067",
    "--tx-terminal-green": "#57ab5a",
    "--tx-terminal-yellow": "#c69026",
    "--tx-terminal-blue": "#539bf5",
    "--tx-terminal-magenta": "#b083f0",
    "--tx-terminal-cyan": "#39c5cf",
    "--tx-terminal-white": "#909dab",
    "--tx-terminal-bright-black": "#545d68",
    "--tx-terminal-bright-red": "#ff938a",
    "--tx-terminal-bright-green": "#6bc46d",
    "--tx-terminal-bright-yellow": "#daaa3f",
    "--tx-terminal-bright-blue": "#6cb6ff",
    "--tx-terminal-bright-magenta": "#c297ff",
    "--tx-terminal-bright-cyan": "#56d4dd",
    "--tx-terminal-bright-white": "#cdd9e5",
  },
  light: {
    "--tx-terminal-background": "#fcfcfd",
    "--tx-terminal-foreground": "#1f232b",
    "--tx-terminal-cursor": "#dc2626",
    "--tx-terminal-cursor-accent": "#fcfcfd",
    "--tx-terminal-selection": "rgba(220, 38, 38, 0.18)",
    "--tx-terminal-selection-inactive": "rgba(220, 38, 38, 0.1)",
    "--tx-terminal-selection-foreground": "#111318",
    "--tx-terminal-black": "#4b5563",
    "--tx-terminal-red": "#cf222e",
    "--tx-terminal-green": "#1a7f37",
    "--tx-terminal-yellow": "#9a6700",
    "--tx-terminal-blue": "#0969da",
    "--tx-terminal-magenta": "#8250df",
    "--tx-terminal-cyan": "#1b7c83",
    "--tx-terminal-white": "#5a6470",
    "--tx-terminal-bright-black": "#6e7781",
    "--tx-terminal-bright-red": "#a40e26",
    "--tx-terminal-bright-green": "#116329",
    "--tx-terminal-bright-yellow": "#7d4e00",
    "--tx-terminal-bright-blue": "#0550ae",
    "--tx-terminal-bright-magenta": "#6f42c1",
    "--tx-terminal-bright-cyan": "#0f5f67",
    "--tx-terminal-bright-white": "#24292f",
  },
} as const;

function terminalTheme(theme: ThemeMode) {
  const vars = TERMINAL_CSS_VARS[theme];
  return {
    background: vars["--tx-terminal-background"],
    foreground: vars["--tx-terminal-foreground"],
    cursor: vars["--tx-terminal-cursor"],
    cursorAccent: vars["--tx-terminal-cursor-accent"],
    selectionBackground: vars["--tx-terminal-selection"],
    selectionInactiveBackground: vars["--tx-terminal-selection-inactive"],
    selectionForeground: vars["--tx-terminal-selection-foreground"],
    black: vars["--tx-terminal-black"],
    red: vars["--tx-terminal-red"],
    green: vars["--tx-terminal-green"],
    yellow: vars["--tx-terminal-yellow"],
    blue: vars["--tx-terminal-blue"],
    magenta: vars["--tx-terminal-magenta"],
    cyan: vars["--tx-terminal-cyan"],
    white: vars["--tx-terminal-white"],
    brightBlack: vars["--tx-terminal-bright-black"],
    brightRed: vars["--tx-terminal-bright-red"],
    brightGreen: vars["--tx-terminal-bright-green"],
    brightYellow: vars["--tx-terminal-bright-yellow"],
    brightBlue: vars["--tx-terminal-bright-blue"],
    brightMagenta: vars["--tx-terminal-bright-magenta"],
    brightCyan: vars["--tx-terminal-bright-cyan"],
    brightWhite: vars["--tx-terminal-bright-white"],
  };
}

let latestOnData: ((data: string) => void) | null = null;
let latestResizeObserverTrigger: (() => void) | null = null;
const terminalMockState = vi.hoisted(() => ({
  latestFitSpy: null as ReturnType<typeof vi.fn> | null,
  terminalInstances: [] as Array<{ options: Record<string, unknown> }>,
}));

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
    options: Record<string, unknown>;
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn((callback: (data: string) => void) => {
      latestOnData = callback;
      return { dispose: vi.fn() };
    });
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();

    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
      terminalMockState.terminalInstances.push(this);
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = vi.fn(() => {});

    constructor() {
      terminalMockState.latestFitSpy = this.fit;
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
  terminalMockState.latestFitSpy = null;
  terminalMockState.terminalInstances = [];
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLDivElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 320,
  });
  Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 180,
  });
  const getComputedStyleMock = (element: Element) => {
    const theme =
      element.getAttribute("data-terminal-theme") === "light" ? "light" : "dark";
    const vars = TERMINAL_CSS_VARS[theme];
    return {
      getPropertyValue: (name: string) =>
        vars[name as keyof typeof vars] ?? "",
    } as CSSStyleDeclaration;
  };
  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    value: getComputedStyleMock,
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: getComputedStyleMock,
  });
});

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TerminalView", () => {
  it("applies the terminal theme on mount and updates it in place on theme change", async () => {
    const { rerender } = render(
      <TerminalView ptyId="pty-1" active={false} exited={false} theme="dark" />,
    );
    await flushEffects();

    expect(terminalMockState.terminalInstances).toHaveLength(1);
    expect(terminalMockState.terminalInstances[0]?.options.theme).toEqual(
      terminalTheme("dark"),
    );

    rerender(
      <TerminalView ptyId="pty-1" active={false} exited={false} theme="light" />,
    );
    await flushEffects();

    expect(terminalMockState.terminalInstances).toHaveLength(1);
    expect(terminalMockState.terminalInstances[0]?.options.theme).toEqual(
      terminalTheme("light"),
    );
  });

  it("stops forwarding input and resize after a not_found write failure", async () => {
    mockedBridge.writeTerminal.mockRejectedValueOnce({
      code: "not_found",
      message: "terminal session not found",
    });

    render(
      <TerminalView ptyId="pty-1" active={false} exited={false} theme="dark" />,
    );
    await flushEffects();

    expect(mockedBridge.resizeTerminal).toHaveBeenCalledTimes(1);
    expect(terminalMockState.latestFitSpy).toHaveBeenCalledTimes(1);

    latestOnData?.("pwd\n");
    await flushEffects();
    expect(mockedBridge.writeTerminal).toHaveBeenCalledTimes(1);

    latestOnData?.("ls\n");
    latestResizeObserverTrigger?.();
    await flushEffects();

    expect(mockedBridge.writeTerminal).toHaveBeenCalledTimes(1);
    expect(mockedBridge.resizeTerminal).toHaveBeenCalledTimes(1);
    expect(terminalMockState.latestFitSpy).toHaveBeenCalledTimes(2);
  });
});
