import { useCallback, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import * as bridge from "../../lib/bridge";

type Props = {
  ptyId: string;
  active: boolean;
};

const THEME = {
  background: "#0e0f12",
  foreground: "#e7e8ec",
  cursor: "#ff4f4f",
  cursorAccent: "#0e0f12",
  selectionBackground: "rgba(255, 79, 79, 0.25)",
};

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function TerminalView({ ptyId, active }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

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
      void bridge.resizeTerminal({ ptyId, cols: term.cols, rows: term.rows });
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
      theme: THEME,
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
      void bridge.writeTerminal({ ptyId, dataBase64: encodeBase64(data) });
    });

    // Reflow xterm whenever its container changes size.
    const resizeObserver = new ResizeObserver(refit);
    resizeObserver.observe(container);

    // PTY -> FE: write incoming bytes (filtered by ptyId at the listener).
    let unlistenOutput: (() => void) | null = null;
    let cancelled = false;
    bridge
      .listenToTerminalOutput((payload) => {
        if (payload.ptyId !== ptyId) return;
        term.write(decodeBase64(payload.dataBase64));
      })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          unlistenOutput = unlisten;
        }
      });

    return () => {
      cancelled = true;
      dataSubscription.dispose();
      resizeObserver.disconnect();
      unlistenOutput?.();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [ptyId, refit]);

  // When activating after being hidden, the container had clientWidth=0,
  // so the initial fit() couldn't run. Refit + focus on activation.
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      refit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active, refit]);

  return (
    <div
      ref={containerRef}
      className={`terminal-view ${active ? "" : "terminal-view--hidden"}`}
    />
  );
}
