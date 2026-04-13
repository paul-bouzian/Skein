import { useRef, useState, type ReactNode } from "react";
import "./Tooltip.css";

type Props = {
  content: string;
  children: ReactNode;
  side?: "top" | "bottom";
  delay?: number;
};

export function Tooltip({ content, children, side = "top", delay = 200 }: Props) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function show() {
    timerRef.current = setTimeout(() => setVisible(true), delay);
  }

  function hide() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
  }

  return (
    <span
      className="tx-tooltip-anchor"
      onPointerEnter={show}
      onPointerLeave={hide}
    >
      {children}
      {visible ? (
        <span className={`tx-tooltip tx-tooltip--${side}`} role="tooltip">
          {content}
        </span>
      ) : null}
    </span>
  );
}
