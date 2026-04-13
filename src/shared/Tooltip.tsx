import { useRef, useState, useLayoutEffect, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./Tooltip.css";

type Props = {
  content: string;
  children: ReactNode;
  side?: "top" | "bottom";
  delay?: number;
};

export function Tooltip({ content, children, side = "top", delay = 200 }: Props) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    if (!visible || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const top = side === "top" ? rect.top - 6 : rect.bottom + 6;
    const left = rect.left + rect.width / 2;
    setPosition({ top, left });
  }, [visible, side]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  function show() {
    timerRef.current = setTimeout(() => setVisible(true), delay);
  }

  function hide() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
    setPosition(null);
  }

  return (
    <span
      ref={anchorRef}
      className="tx-tooltip-anchor"
      onPointerEnter={show}
      onPointerLeave={hide}
    >
      {children}
      {visible && position
        ? createPortal(
            <span
              className={`tx-tooltip tx-tooltip--${side}`}
              role="tooltip"
              style={{ top: position.top, left: position.left }}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
