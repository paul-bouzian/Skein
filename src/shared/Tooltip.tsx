import { useRef, useState, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useTooltipPosition } from "./useTooltipPosition";

import "./Tooltip.css";

type Props = {
  content: string;
  children: ReactNode;
  side?: "top" | "bottom";
  delay?: number;
  repositionKey?: unknown;
};

export function Tooltip({
  content,
  children,
  side = "top",
  delay = 200,
  repositionKey,
}: Props) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const position = useTooltipPosition({
    anchorRef,
    tooltipRef,
    open: visible,
    preferredSide: side,
    gapPx: 6,
    repositionKey: repositionKey ?? content,
  });

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  function show() {
    clearShowTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setVisible(true);
    }, delay);
  }

  function hide() {
    clearShowTimer();
    setVisible(false);
  }

  function clearShowTimer() {
    if (!timerRef.current) {
      return;
    }
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  return (
    <span
      ref={anchorRef}
      className="tx-tooltip-anchor"
      onPointerEnter={show}
      onPointerLeave={hide}
    >
      {children}
      {visible
        ? createPortal(
            <span
              ref={tooltipRef}
              className="tx-tooltip"
              role="tooltip"
              style={{
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                visibility: position ? "visible" : "hidden",
              }}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
