import { useEffect, useRef, useState, type ReactNode } from "react";

import "./SmoothCollapse.css";

const ANIMATION_MS = 250;

type Props = {
  open: boolean;
  children: ReactNode | (() => ReactNode);
  className?: string;
  id?: string;
};

export function SmoothCollapse({ open, children, className, id }: Props) {
  const [mounted, setMounted] = useState(open);
  const [visualOpen, setVisualOpen] = useState(open);
  const closeTimerRef = useRef<number | null>(null);
  const openRafRef = useRef<number | null>(null);
  const openRafInnerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearPending = () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      if (openRafRef.current !== null) {
        window.cancelAnimationFrame(openRafRef.current);
        openRafRef.current = null;
      }
      if (openRafInnerRef.current !== null) {
        window.cancelAnimationFrame(openRafInnerRef.current);
        openRafInnerRef.current = null;
      }
    };

    clearPending();

    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    if (reducedMotion) {
      setMounted(open);
      setVisualOpen(open);
      return clearPending;
    }

    if (open) {
      setMounted(true);
      openRafRef.current = window.requestAnimationFrame(() => {
        openRafRef.current = null;
        openRafInnerRef.current = window.requestAnimationFrame(() => {
          openRafInnerRef.current = null;
          setVisualOpen(true);
        });
      });
    } else {
      setVisualOpen(false);
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        setMounted(false);
      }, ANIMATION_MS);
    }

    return clearPending;
  }, [open]);

  if (!mounted) {
    return null;
  }

  const wrapperClassName = [
    "tx-collapse",
    visualOpen ? "tx-collapse--open" : null,
    className ?? null,
  ]
    .filter(Boolean)
    .join(" ");

  const renderedChildren =
    typeof children === "function" ? children() : children;

  return (
    <div
      className={wrapperClassName}
      aria-hidden={!open}
      inert={!open}
      id={id}
    >
      <div className="tx-collapse__inner">{renderedChildren}</div>
    </div>
  );
}
