import { useCallback, useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import * as bridge from "../../lib/bridge";
import { subscribeToTerminalOutput } from "../../lib/terminal-output-bus";
import type { Theme } from "./StudioShell";

type Props = {
  ptyId: string;
  active: boolean;
  exited: boolean;
  theme: Theme;
};

function readCssToken(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim();
}

function readTerminalTheme(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  return {
    background: readCssToken(style, "--tx-terminal-background"),
    foreground: readCssToken(style, "--tx-terminal-foreground"),
    cursor: readCssToken(style, "--tx-terminal-cursor"),
    cursorAccent: readCssToken(style, "--tx-terminal-cursor-accent"),
    selectionBackground: readCssToken(style, "--tx-terminal-selection"),
    selectionInactiveBackground: readCssToken(
      style,
      "--tx-terminal-selection-inactive",
    ),
    selectionForeground: readCssToken(
      style,
      "--tx-terminal-selection-foreground",
    ),
    black: readCssToken(style, "--tx-terminal-black"),
    red: readCssToken(style, "--tx-terminal-red"),
    green: readCssToken(style, "--tx-terminal-green"),
    yellow: readCssToken(style, "--tx-terminal-yellow"),
    blue: readCssToken(style, "--tx-terminal-blue"),
    magenta: readCssToken(style, "--tx-terminal-magenta"),
    cyan: readCssToken(style, "--tx-terminal-cyan"),
    white: readCssToken(style, "--tx-terminal-white"),
    brightBlack: readCssToken(style, "--tx-terminal-bright-black"),
    brightRed: readCssToken(style, "--tx-terminal-bright-red"),
    brightGreen: readCssToken(style, "--tx-terminal-bright-green"),
    brightYellow: readCssToken(style, "--tx-terminal-bright-yellow"),
    brightBlue: readCssToken(style, "--tx-terminal-bright-blue"),
    brightMagenta: readCssToken(style, "--tx-terminal-bright-magenta"),
    brightCyan: readCssToken(style, "--tx-terminal-bright-cyan"),
    brightWhite: readCssToken(style, "--tx-terminal-bright-white"),
  } satisfies ITheme;
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function isTerminalSessionGone(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return error.code === "not_found";
  }
  if (error instanceof Error) {
    return /terminal session not found/i.test(error.message);
  }
  return (
    typeof error === "string" && /terminal session not found/i.test(error)
  );
}

export function TerminalView({ ptyId, active, exited, theme }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalGoneRef = useRef(exited);

  useEffect(() => {
    terminalGoneRef.current = exited;
  }, [exited]);

  // Fit xterm to its container and propagate the new dimensions to the PTY.
  // Safe to call when the container is hidden (clientWidth=0): no-ops instead
  // of throwing.
  const refit = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    if (!term || !fit || !container) return;
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    try {
      fit.fit();
      if (terminalGoneRef.current) return;
      void bridge
        .resizeTerminal({ ptyId, cols: term.cols, rows: term.rows })
        .catch((error) => {
          if (isTerminalSessionGone(error)) {
            terminalGoneRef.current = true;
            return;
          }
          console.error("Failed to resize terminal:", error);
        });
    } catch {
      /* ignore */
    }
  }, [ptyId]);

  // Create + dispose the xterm instance once per ptyId.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12.5,
      theme: readTerminalTheme(container),
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);

    termRef.current = term;
    fitRef.current = fit;

    // Initial fit — defers one tick so the container has its layout box.
    queueMicrotask(refit);

    // FE -> PTY: forward keystrokes / paste / wheel input.
    const dataSubscription = term.onData((data) => {
      if (terminalGoneRef.current) return;
      void bridge
        .writeTerminal({ ptyId, dataBase64: encodeBase64(data) })
        .catch((error) => {
          if (isTerminalSessionGone(error)) {
            terminalGoneRef.current = true;
            return;
          }
          console.error("Failed to write to terminal:", error);
        });
    });

    // Reflow xterm whenever its container changes size.
    const resizeObserver = new ResizeObserver(refit);
    resizeObserver.observe(container);

    // PTY -> FE: attach to the output bus. The bus flushes any output
    // received before this subscribe (emitted between spawn and mount) so
    // the initial prompt isn't lost.
    const unlistenOutput = subscribeToTerminalOutput(ptyId, (bytes) => {
      term.write(bytes);
    });

    return () => {
      dataSubscription.dispose();
      resizeObserver.disconnect();
      unlistenOutput();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [ptyId, refit]);

  useEffect(() => {
    const term = termRef.current;
    const container = containerRef.current;
    if (!term || !container) return;
    term.options.theme = { ...readTerminalTheme(container) };
  }, [theme]);

  // When activating after being hidden, the container had clientWidth=0,
  // so the initial fit() couldn't run. Refit + focus on activation.
  useEffect(() => {
    if (!active || terminalGoneRef.current) return;
    const id = requestAnimationFrame(() => {
      refit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active, refit]);

  return (
    <div
      ref={containerRef}
      data-terminal-theme={theme}
      className={`terminal-view ${active ? "" : "terminal-view--hidden"}`}
    />
  );
}
