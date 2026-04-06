import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import * as bridge from "../../../lib/bridge";
import type {
  EnvironmentRecord,
  EnvironmentTerminalSnapshot,
  TerminalEventPayload,
} from "../../../lib/types";
import "@xterm/xterm/css/xterm.css";

type Props = {
  environment: EnvironmentRecord;
  terminalId: string;
};

export function TerminalPanel({ environment, terminalId }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [snapshot, setSnapshot] = useState<EnvironmentTerminalSnapshot | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const status = snapshot?.status ?? (error ? "error" : "running");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    const terminal = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      fontSize: 12,
      lineHeight: 1.2,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    applyTerminalTheme(terminal);
    fitAddon.fit();

    const handleData = (data: string) => {
      void bridge.writeEnvironmentTerminal({
        environmentId: environment.id,
        terminalId,
        data,
      });
    };
    terminal.onData(handleData);

    const themeObserver = new MutationObserver(() => {
      applyTerminalTheme(terminal);
      fitAddon.fit();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      themeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [environment.id, terminalId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const host = hostRef.current;
    if (!terminal || !fitAddon || !host) {
      return undefined;
    }

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const bufferedEvents: TerminalEventPayload[] = [];
    let ready = false;

    setSnapshot(null);
    setError(null);
    setLoading(true);

    const fitAndResize = () => {
      const currentTerminal = terminalRef.current;
      const currentFitAddon = fitAddonRef.current;
      if (!currentTerminal || !currentFitAddon) return;
      currentFitAddon.fit();
      void bridge.resizeEnvironmentTerminal({
        environmentId: environment.id,
        terminalId,
        cols: currentTerminal.cols,
        rows: currentTerminal.rows,
      });
    };

    resizeObserverRef.current?.disconnect();
    const resizeObserver = new ResizeObserver(() => {
      fitAndResize();
    });
    resizeObserver.observe(host);
    resizeObserverRef.current = resizeObserver;

    void (async () => {
      try {
        unlisten = await bridge.listenToTerminalEvents((payload) => {
          if (
            payload.environmentId !== environment.id ||
            payload.terminalId !== terminalId
          ) {
            return;
          }

          if (!ready) {
            bufferedEvents.push(payload);
            return;
          }
          handleTerminalEvent(terminal, payload, setSnapshot, setError);
        });

        fitAddon.fit();
        const openedSnapshot = await bridge.openEnvironmentTerminal({
          environmentId: environment.id,
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        if (cancelled) return;

        terminal.reset();
        applyTerminalTheme(terminal);
        if (openedSnapshot.history.length > 0) {
          terminal.write(openedSnapshot.history);
        }
        setSnapshot(openedSnapshot);
        ready = true;
        for (const payload of bufferedEvents) {
          if (payload.sequence > openedSnapshot.eventSequence) {
            handleTerminalEvent(terminal, payload, setSnapshot, setError);
          }
        }
        bufferedEvents.length = 0;
        setLoading(false);
      } catch (cause: unknown) {
        if (cancelled) return;
        const message =
          cause instanceof Error ? cause.message : "Failed to open terminal";
        setError(message);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      resizeObserverRef.current = null;
      unlisten?.();
    };
  }, [environment.id, terminalId]);

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__meta">
        <span
          className="terminal-panel__cwd"
          title={snapshot?.cwd ?? environment.path}
        >
          {snapshot?.cwd ?? environment.path}
        </span>
        <span
          className={`terminal-panel__status terminal-panel__status--${status}`}
        >
          {terminalStatusLabel(snapshot, error, loading)}
        </span>
      </div>
      <div className="terminal-panel__surface">
        <div ref={hostRef} className="terminal-panel__xterm" />
        {loading ? (
          <div className="terminal-panel__overlay">Connecting shell…</div>
        ) : null}
        {!loading && error ? (
          <div className="terminal-panel__overlay">{error}</div>
        ) : null}
      </div>
    </div>
  );
}

function applyTerminalTheme(terminal: Terminal) {
  const styles = getComputedStyle(document.documentElement);
  const theme = {
    background: readCssVar(styles, "--tx-bg-base", "#0f1115"),
    foreground: readCssVar(styles, "--tx-text-primary", "#f4f7fb"),
    cursor: readCssVar(styles, "--tx-accent", "#7dd3fc"),
    cursorAccent: readCssVar(styles, "--tx-bg-base", "#0f1115"),
    selectionBackground: readCssVar(styles, "--tx-bg-hover", "#1f2630"),
    black: readCssVar(styles, "--tx-bg-hover", "#1f2630"),
    brightBlack: readCssVar(styles, "--tx-text-muted", "#8290a3"),
    white: readCssVar(styles, "--tx-text-primary", "#f4f7fb"),
    brightWhite: readCssVar(styles, "--tx-text-primary", "#f4f7fb"),
  };

  terminal.options.theme = theme;
  terminal.options.fontFamily = readCssVar(
    styles,
    "--tx-font-mono",
    "monospace",
  );
}

function readCssVar(
  styles: CSSStyleDeclaration,
  name: string,
  fallback: string,
) {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

function terminalStatusLabel(
  snapshot: EnvironmentTerminalSnapshot | null,
  error: string | null,
  loading: boolean,
) {
  if (error) return "Error";
  if (!snapshot) return loading ? "Connecting…" : "Shell";
  switch (snapshot.status) {
    case "running":
      return "Running";
    case "exited":
      return "Exited";
    case "error":
      return "Error";
  }
}

function handleTerminalEvent(
  terminal: Terminal,
  payload: TerminalEventPayload,
  setSnapshot: Dispatch<SetStateAction<EnvironmentTerminalSnapshot | null>>,
  setError: Dispatch<SetStateAction<string | null>>,
) {
  switch (payload.type) {
    case "output":
      terminal.write(payload.data);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              eventSequence: payload.sequence,
              updatedAt: payload.createdAt,
            }
          : current,
      );
      return;
    case "exited":
      setSnapshot((current) =>
        current
          ? {
              ...current,
              status: "exited",
              exitCode: payload.exitCode ?? null,
              eventSequence: payload.sequence,
              updatedAt: payload.createdAt,
            }
          : current,
      );
      return;
    case "error":
      setError(payload.message);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              status: "error",
              eventSequence: payload.sequence,
              updatedAt: payload.createdAt,
            }
          : current,
      );
      return;
    case "started":
      setSnapshot(payload.snapshot);
  }
}
