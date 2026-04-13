import { useLayoutEffect, useState, type RefObject } from "react";

import {
  computeTooltipPosition,
  DEFAULT_TOOLTIP_VIEWPORT_MARGIN_PX,
  type TooltipPosition,
  type TooltipSide,
} from "./tooltip-position";

type UseTooltipPositionArgs = {
  anchorRef: RefObject<HTMLElement | null>;
  tooltipRef: RefObject<HTMLElement | null>;
  open: boolean;
  preferredSide: TooltipSide;
  gapPx: number;
  viewportMarginPx?: number;
  repositionKey?: unknown;
};

export function useTooltipPosition({
  anchorRef,
  tooltipRef,
  open,
  preferredSide,
  gapPx,
  viewportMarginPx = DEFAULT_TOOLTIP_VIEWPORT_MARGIN_PX,
  repositionKey,
}: UseTooltipPositionArgs): TooltipPosition | null {
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    function updateTooltipPosition() {
      const anchor = anchorRef.current;
      const tooltip = tooltipRef.current;
      if (!anchor || !tooltip) {
        return;
      }

      const nextPosition = computeTooltipPosition({
        anchorRect: anchor.getBoundingClientRect(),
        tooltipRect: tooltip.getBoundingClientRect(),
        preferredSide,
        gapPx,
        viewportMarginPx,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });

      setPosition((current) =>
        positionsMatch(current, nextPosition) ? current : nextPosition,
      );
    }

    updateTooltipPosition();
    window.addEventListener("resize", updateTooltipPosition);
    window.addEventListener("scroll", updateTooltipPosition, true);
    return () => {
      window.removeEventListener("resize", updateTooltipPosition);
      window.removeEventListener("scroll", updateTooltipPosition, true);
    };
  }, [
    anchorRef,
    gapPx,
    open,
    preferredSide,
    repositionKey,
    tooltipRef,
    viewportMarginPx,
  ]);

  return position;
}

function positionsMatch(
  current: TooltipPosition | null,
  next: TooltipPosition,
) {
  return current?.left === next.left && current.top === next.top;
}
