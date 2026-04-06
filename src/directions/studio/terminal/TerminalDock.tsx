import type { MouseEvent as ReactMouseEvent } from "react";

import { CloseIcon, PlusIcon } from "../../../shared/Icons";
import type { EnvironmentRecord } from "../../../lib/types";
import type { TerminalTab } from "../../../stores/terminal-store";
import { TerminalPanel } from "./TerminalPanel";
import "./TerminalDock.css";

type Props = {
  environment: EnvironmentRecord;
  tabs: TerminalTab[];
  activeTerminalId: string | null;
  heightPx: number;
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onSelectTerminal: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onCreateTerminal: () => void;
};

export function TerminalDock({
  environment,
  tabs,
  activeTerminalId,
  heightPx,
  onResizeStart,
  onSelectTerminal,
  onCloseTerminal,
  onCreateTerminal,
}: Props) {
  const activeTerminal = activeTerminalId
    ? tabs.find((tab) => tab.id === activeTerminalId) ?? null
    : null;

  return (
    <section className="terminal-dock" style={{ height: `${heightPx}px` }}>
      <div
        className="terminal-dock__resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal panel"
        onMouseDown={onResizeStart}
      />
      <div className="terminal-dock__header">
        <div className="terminal-dock__tabs" role="tablist" aria-label="Terminal tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-dock__tab ${tab.id === activeTerminalId ? "terminal-dock__tab--active" : ""}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeTerminalId}
                className="terminal-dock__tab-select"
                onClick={() => onSelectTerminal(tab.id)}
              >
                <span className="terminal-dock__tab-label">{tab.title}</span>
              </button>
              <button
                type="button"
                className="terminal-dock__tab-close"
                aria-label={`Close ${tab.title}`}
                onClick={() => onCloseTerminal(tab.id)}
              >
                <CloseIcon size={10} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="terminal-dock__action"
          aria-label="New terminal"
          title="New terminal"
          onClick={onCreateTerminal}
        >
          <PlusIcon size={12} />
        </button>
      </div>
      <div className="terminal-dock__body">
        {activeTerminal ? (
          <TerminalPanel environment={environment} terminalId={activeTerminal.id} />
        ) : null}
      </div>
    </section>
  );
}
