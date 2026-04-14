import { useRef, type KeyboardEvent, type PointerEvent } from "react";

import {
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
} from "../../stores/workspace-store";

type Props = {
  orientation: "row" | "column";
  ratio: number;
  onCommit: (ratio: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
};

type DragSession = {
  pointerStart: number;
  startRatio: number;
  containerSize: number;
  grid: HTMLElement | null;
  varName: "--studio-row-ratio" | "--studio-col-ratio";
  lastRatio: number;
};

const KEYBOARD_STEP = 0.02;

export function PaneSplitter({
  orientation,
  ratio,
  onCommit,
  onDraggingChange,
}: Props) {
  const sessionRef = useRef<DragSession | null>(null);
  const isRow = orientation === "row";
  const varName = isRow ? "--studio-col-ratio" : "--studio-row-ratio";

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const session = sessionRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (session) onCommit(session.lastRatio);
    sessionRef.current = null;
    onDraggingChange?.(false);
  }

  function adjustByKeyboard(
    event: KeyboardEvent<HTMLDivElement>,
    delta: number | "min" | "max",
  ) {
    event.preventDefault();
    const grid = event.currentTarget.closest<HTMLElement>(".studio-main__grid");
    const current = readCssRatio(grid, varName);
    const next =
      delta === "min"
        ? SPLIT_RATIO_MIN
        : delta === "max"
          ? SPLIT_RATIO_MAX
          : Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, current + delta));
    grid?.style.setProperty(varName, String(next));
    onCommit(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Arrow keys adjust the ratio along the splitter's primary axis.
    if (isRow) {
      if (event.key === "ArrowLeft") return adjustByKeyboard(event, -KEYBOARD_STEP);
      if (event.key === "ArrowRight") return adjustByKeyboard(event, KEYBOARD_STEP);
    } else {
      if (event.key === "ArrowUp") return adjustByKeyboard(event, -KEYBOARD_STEP);
      if (event.key === "ArrowDown") return adjustByKeyboard(event, KEYBOARD_STEP);
    }
    if (event.key === "Home") return adjustByKeyboard(event, "min");
    if (event.key === "End") return adjustByKeyboard(event, "max");
  }

  return (
    <div
      className={
        "studio-main__pane-splitter" +
        (isRow
          ? " studio-main__pane-splitter--row"
          : " studio-main__pane-splitter--column")
      }
      role="separator"
      aria-orientation={isRow ? "vertical" : "horizontal"}
      aria-label="Resize split"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(SPLIT_RATIO_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_RATIO_MAX * 100)}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        const container = handle.parentElement;
        const rect = container?.getBoundingClientRect();
        const containerSize = rect ? (isRow ? rect.width : rect.height) : 0;
        const grid = handle.closest<HTMLElement>(".studio-main__grid");
        const startRatio = readCssRatio(grid, varName);
        sessionRef.current = {
          pointerStart: isRow ? event.clientX : event.clientY,
          startRatio,
          containerSize,
          grid,
          varName,
          lastRatio: startRatio,
        };
        onDraggingChange?.(true);
      }}
      onPointerMove={(event) => {
        const session = sessionRef.current;
        if (!session || session.containerSize === 0) return;
        const pointer = isRow ? event.clientX : event.clientY;
        const delta = (pointer - session.pointerStart) / session.containerSize;
        const next = Math.min(
          SPLIT_RATIO_MAX,
          Math.max(SPLIT_RATIO_MIN, session.startRatio + delta),
        );
        session.lastRatio = next;
        // Write the CSS variable directly — no React re-render needed; the
        // flex-basis `calc(var(...) * 100%)` picks up the new value at paint.
        session.grid?.style.setProperty(session.varName, String(next));
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}

function readCssRatio(
  grid: HTMLElement | null,
  varName: "--studio-row-ratio" | "--studio-col-ratio",
): number {
  if (!grid) return 0.5;
  const raw = getComputedStyle(grid).getPropertyValue(varName).trim();
  const parsed = parseFloat(raw);
  if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) {
    return parsed;
  }
  return 0.5;
}
