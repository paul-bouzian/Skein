import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";

import {
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  SIDEBAR_PANEL_MAX_WIDTH,
  SIDEBAR_PANEL_MIN_WIDTH,
  clampSidebarPanelWidth,
  clampSidePanelWidth,
} from "../../stores/side-panel-store";

const KEYBOARD_STEP = 16;

type Props = {
  width: number;
  side?: "left" | "right";
  onResize: (width: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
};

type DragSession = {
  pointerStart: number;
  startWidth: number;
  lastWidth: number;
};

type PanelConfig = {
  cssVar: string;
  label: string;
  minWidth: number;
  maxWidth: number;
  clampWidth: (width: number) => number;
  dragSign: 1 | -1;
};

function configForSide(side: "left" | "right"): PanelConfig {
  if (side === "left") {
    return {
      cssVar: "--tx-sidebar-width",
      label: "Resize projects sidebar",
      minWidth: SIDEBAR_PANEL_MIN_WIDTH,
      maxWidth: SIDEBAR_PANEL_MAX_WIDTH,
      clampWidth: clampSidebarPanelWidth,
      dragSign: 1,
    };
  }
  return {
    cssVar: "--tx-side-panel-width",
    label: "Resize side panel",
    minWidth: SIDE_PANEL_MIN_WIDTH,
    maxWidth: SIDE_PANEL_MAX_WIDTH,
    clampWidth: clampSidePanelWidth,
    dragSign: -1,
  };
}

function writeCssVar(name: string, value: number): void {
  document.documentElement.style.setProperty(name, `${value}px`);
}

function keyboardDelta(
  key: string,
  width: number,
  side: "left" | "right",
  config: PanelConfig,
): number | null {
  switch (key) {
    case "ArrowLeft":
      return config.clampWidth(
        side === "left" ? width - KEYBOARD_STEP : width + KEYBOARD_STEP,
      );
    case "ArrowRight":
      return config.clampWidth(
        side === "left" ? width + KEYBOARD_STEP : width - KEYBOARD_STEP,
      );
    case "Home":
      return side === "left" ? config.minWidth : config.maxWidth;
    case "End":
      return side === "left" ? config.maxWidth : config.minWidth;
    default:
      return null;
  }
}

export function SidePanelResizer({
  width,
  side = "right",
  onResize,
  onDraggingChange,
}: Props) {
  const sessionRef = useRef<DragSession | null>(null);
  const config = configForSide(side);

  // If a panel is hidden mid-drag the handle unmounts without firing pointerup.
  // Commit whatever width the session reached so the CSS var and store agree.
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
    const next = keyboardDelta(event.key, width, side, config);
    if (next === null) return;
    event.preventDefault();
    writeCssVar(config.cssVar, next);
    onResize(next);
  }

  return (
    <div
      className={`side-panel-resizer side-panel-resizer--${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={config.label}
      aria-valuenow={width}
      aria-valuemin={config.minWidth}
      aria-valuemax={config.maxWidth}
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
        const delta = event.clientX - session.pointerStart;
        const next = config.clampWidth(session.startWidth + delta * config.dragSign);
        session.lastWidth = next;
        writeCssVar(config.cssVar, next);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
