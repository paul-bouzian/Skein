import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";

import {
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  clampSidePanelWidth,
} from "../../stores/side-panel-store";

const KEYBOARD_STEP = 16;
const CSS_VAR = "--tx-side-panel-width";

type Props = {
  width: number;
  onResize: (width: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
};

type DragSession = {
  pointerStart: number;
  startWidth: number;
  lastWidth: number;
};

function writeCssVar(value: number): void {
  document.documentElement.style.setProperty(CSS_VAR, `${value}px`);
}

function keyboardDelta(
  key: string,
  width: number,
): number | null {
  switch (key) {
    case "ArrowLeft":
      return clampSidePanelWidth(width + KEYBOARD_STEP);
    case "ArrowRight":
      return clampSidePanelWidth(width - KEYBOARD_STEP);
    case "Home":
      return SIDE_PANEL_MAX_WIDTH;
    case "End":
      return SIDE_PANEL_MIN_WIDTH;
    default:
      return null;
  }
}

export function SidePanelResizer({
  width,
  onResize,
  onDraggingChange,
}: Props) {
  const sessionRef = useRef<DragSession | null>(null);

  // If the panel is hidden mid-drag the handle unmounts without firing
  // pointerup, leaving `--tx-side-panel-width` at the preview value and
  // the shell's `sidePanelDragging` stuck true. Commit whatever width
  // the session reached on unmount.
  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      onResize(session.lastWidth);
      onDraggingChange?.(false);
    };
  }, [onResize, onDraggingChange]);

  function endDrag(event: PointerEvent<HTMLDivElement>): void {
    const session = sessionRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (session) {
      onResize(session.lastWidth);
    }
    sessionRef.current = null;
    onDraggingChange?.(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const next = keyboardDelta(event.key, width);
    if (next === null) return;
    event.preventDefault();
    writeCssVar(next);
    onResize(next);
  }

  return (
    <div
      className="side-panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      aria-valuenow={width}
      aria-valuemin={SIDE_PANEL_MIN_WIDTH}
      aria-valuemax={SIDE_PANEL_MAX_WIDTH}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        sessionRef.current = {
          pointerStart: event.clientX,
          startWidth: width,
          lastWidth: width,
        };
        onDraggingChange?.(true);
      }}
      onPointerMove={(event) => {
        const session = sessionRef.current;
        if (!session) return;
        // Dragging the handle to the LEFT should grow the panel (the panel is
        // anchored to the right edge of the window). So we subtract delta.
        const delta = event.clientX - session.pointerStart;
        const next = clampSidePanelWidth(session.startWidth - delta);
        session.lastWidth = next;
        writeCssVar(next);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
