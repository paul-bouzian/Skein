export type TooltipSide = "top" | "bottom";

type ComputeTooltipPositionArgs = {
  anchorRect: DOMRectReadOnly;
  tooltipRect: DOMRectReadOnly;
  preferredSide: TooltipSide;
  gapPx: number;
  viewportMarginPx: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type TooltipPosition = {
  left: number;
  top: number;
};

export const DEFAULT_TOOLTIP_VIEWPORT_MARGIN_PX = 12;

export function computeTooltipPosition({
  anchorRect,
  tooltipRect,
  preferredSide,
  gapPx,
  viewportMarginPx,
  viewportWidth,
  viewportHeight,
}: ComputeTooltipPositionArgs): TooltipPosition {
  const availableSpace = {
    top: anchorRect.top - viewportMarginPx - gapPx,
    bottom:
      viewportHeight - anchorRect.bottom - viewportMarginPx - gapPx,
  } satisfies Record<TooltipSide, number>;
  const side = resolveTooltipSide(
    preferredSide,
    availableSpace,
    tooltipRect.height,
  );

  return {
    left: clamp(
      anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2,
      viewportMarginPx,
      Math.max(
        viewportMarginPx,
        viewportWidth - tooltipRect.width - viewportMarginPx,
      ),
    ),
    top: clamp(
      side === "top"
        ? anchorRect.top - tooltipRect.height - gapPx
        : anchorRect.bottom + gapPx,
      viewportMarginPx,
      Math.max(
        viewportMarginPx,
        viewportHeight - tooltipRect.height - viewportMarginPx,
      ),
    ),
  };
}

function resolveTooltipSide(
  preferredSide: TooltipSide,
  availableSpace: Record<TooltipSide, number>,
  tooltipHeight: number,
) {
  const alternateSide = preferredSide === "top" ? "bottom" : "top";
  if (availableSpace[preferredSide] >= tooltipHeight) {
    return preferredSide;
  }
  if (availableSpace[alternateSide] >= tooltipHeight) {
    return alternateSide;
  }
  return availableSpace[alternateSide] > availableSpace[preferredSide]
    ? alternateSide
    : preferredSide;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
