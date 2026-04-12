import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  deriveContextWindowSnapshot,
  formatContextWindowTokens,
} from "../../lib/context-window";
import type { ThreadTokenUsageSnapshot } from "../../lib/types";
import "./ContextWindowMeter.css";

type Props = {
  usage?: ThreadTokenUsageSnapshot | null;
};

type TooltipPosition = {
  left: number;
  top: number;
};

const TOOLTIP_GAP_PX = 10;
const VIEWPORT_MARGIN_PX = 12;
const TOOLTIP_Z_INDEX = 60;

export function ContextWindowMeter({ usage }: Props) {
  const snapshot = deriveContextWindowSnapshot(usage);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const tooltipId = useId();
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition | null>(
    null,
  );
  const hasSnapshot = Boolean(snapshot);
  const percentageLabel = snapshot
    ? formatPercentageLabel(snapshot.usedPercentage)
    : null;
  const isTooltipOpen = hasSnapshot && (isHovered || isFocused);
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const dashOffset =
    circumference - ((snapshot?.usedPercentage ?? 0) / 100) * circumference;

  useLayoutEffect(() => {
    if (!hasSnapshot || !isTooltipOpen) {
      setTooltipPosition(null);
      return;
    }

    function updateTooltipPosition() {
      const trigger = triggerRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) {
        return;
      }

      const triggerRect = trigger.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const maxLeft = Math.max(
        VIEWPORT_MARGIN_PX,
        window.innerWidth - tooltipRect.width - VIEWPORT_MARGIN_PX,
      );
      const left = clamp(
        triggerRect.right - tooltipRect.width,
        VIEWPORT_MARGIN_PX,
        maxLeft,
      );
      const maxTop = Math.max(
        VIEWPORT_MARGIN_PX,
        window.innerHeight - tooltipRect.height - VIEWPORT_MARGIN_PX,
      );
      const availableAbove =
        triggerRect.top - VIEWPORT_MARGIN_PX - TOOLTIP_GAP_PX;
      const availableBelow =
        window.innerHeight -
        triggerRect.bottom -
        VIEWPORT_MARGIN_PX -
        TOOLTIP_GAP_PX;
      const openAbove =
        availableAbove >= tooltipRect.height || availableAbove > availableBelow;
      const top = clamp(
        openAbove
          ? triggerRect.top - tooltipRect.height - TOOLTIP_GAP_PX
          : triggerRect.bottom + TOOLTIP_GAP_PX,
        VIEWPORT_MARGIN_PX,
        maxTop,
      );

      setTooltipPosition({ left, top });
    }

    updateTooltipPosition();
    window.addEventListener("resize", updateTooltipPosition);
    window.addEventListener("scroll", updateTooltipPosition, true);
    return () => {
      window.removeEventListener("resize", updateTooltipPosition);
      window.removeEventListener("scroll", updateTooltipPosition, true);
    };
  }, [
    hasSnapshot,
    isTooltipOpen,
    snapshot?.maxTokens,
    snapshot?.totalProcessedTokens,
    snapshot?.usedTokens,
    percentageLabel,
  ]);

  if (!snapshot || !percentageLabel) {
    return null;
  }

  return (
    <div className="tx-context-meter">
      <button
        ref={triggerRef}
        type="button"
        className="tx-context-meter__trigger"
        aria-label={`Context window ${percentageLabel}% used`}
        aria-describedby={isTooltipOpen ? tooltipId : undefined}
        onBlur={() => setIsFocused(false)}
        onFocus={() => setIsFocused(true)}
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => setIsHovered(false)}
      >
        <span className="tx-context-meter__visual">
          <svg viewBox="0 0 28 28" className="tx-context-meter__ring" aria-hidden="true">
            <circle
              cx="14"
              cy="14"
              r={radius}
              className="tx-context-meter__track"
            />
            <circle
              cx="14"
              cy="14"
              r={radius}
              className="tx-context-meter__progress"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
            />
          </svg>
          <span className="tx-context-meter__value">{percentageLabel}</span>
        </span>
      </button>
      {isTooltipOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={tooltipRef}
              id={tooltipId}
              className="tx-context-meter__tooltip"
              role="tooltip"
              style={{
                left: tooltipPosition?.left ?? 0,
                top: tooltipPosition?.top ?? 0,
                visibility: tooltipPosition ? "visible" : "hidden",
                zIndex: TOOLTIP_Z_INDEX,
              }}
            >
              <div className="tx-context-meter__tooltip-label tx-section-label">
                Context window
              </div>
              <div className="tx-context-meter__tooltip-line">
                {percentageLabel}% ·{" "}
                {formatContextWindowTokens(snapshot.usedTokens)}/
                {formatContextWindowTokens(snapshot.maxTokens)} context used
              </div>
              {snapshot.totalProcessedTokens ? (
                <div className="tx-context-meter__tooltip-muted">
                  Total processed:{" "}
                  {formatContextWindowTokens(snapshot.totalProcessedTokens)}{" "}
                  tokens
                </div>
              ) : null}
              <div className="tx-context-meter__tooltip-muted">
                Automatically compacts its context when needed.
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function formatPercentageLabel(value: number) {
  return value < 10
    ? value.toFixed(1).replace(/\.0$/, "")
    : `${Math.round(value)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
