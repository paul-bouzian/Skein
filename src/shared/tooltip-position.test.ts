import { describe, expect, it } from "vitest";

import { computeTooltipPosition } from "./tooltip-position";

describe("computeTooltipPosition", () => {
  it("centers the tooltip when the viewport has enough room", () => {
    expect(
      computeTooltipPosition({
        anchorRect: createRect({ left: 100, top: 100, width: 40, height: 20 }),
        tooltipRect: createRect({ left: 0, top: 0, width: 80, height: 30 }),
        preferredSide: "top",
        gapPx: 6,
        viewportMarginPx: 12,
        viewportWidth: 300,
        viewportHeight: 200,
      }),
    ).toEqual({
      left: 80,
      top: 64,
    });
  });

  it("clamps the tooltip inside the left viewport margin", () => {
    expect(
      computeTooltipPosition({
        anchorRect: createRect({ left: 4, top: 100, width: 24, height: 24 }),
        tooltipRect: createRect({ left: 0, top: 0, width: 140, height: 32 }),
        preferredSide: "top",
        gapPx: 6,
        viewportMarginPx: 12,
        viewportWidth: 320,
        viewportHeight: 240,
      }),
    ).toMatchObject({
      left: 12,
      top: 62,
    });
  });

  it("clamps the tooltip inside the right viewport margin", () => {
    expect(
      computeTooltipPosition({
        anchorRect: createRect({ left: 260, top: 100, width: 40, height: 20 }),
        tooltipRect: createRect({ left: 0, top: 0, width: 140, height: 32 }),
        preferredSide: "top",
        gapPx: 6,
        viewportMarginPx: 12,
        viewportWidth: 300,
        viewportHeight: 240,
      }),
    ).toMatchObject({
      left: 148,
      top: 62,
    });
  });

  it("flips to the opposite side when the preferred side does not fit", () => {
    expect(
      computeTooltipPosition({
        anchorRect: createRect({ left: 100, top: 10, width: 40, height: 20 }),
        tooltipRect: createRect({ left: 0, top: 0, width: 120, height: 30 }),
        preferredSide: "top",
        gapPx: 6,
        viewportMarginPx: 12,
        viewportWidth: 320,
        viewportHeight: 240,
      }),
    ).toMatchObject({
      left: 60,
      top: 36,
    });
  });

  it("chooses the roomier side and clamps vertically when neither side fits", () => {
    expect(
      computeTooltipPosition({
        anchorRect: createRect({ left: 100, top: 34, width: 40, height: 20 }),
        tooltipRect: createRect({ left: 0, top: 0, width: 120, height: 60 }),
        preferredSide: "bottom",
        gapPx: 10,
        viewportMarginPx: 12,
        viewportWidth: 320,
        viewportHeight: 80,
      }),
    ).toMatchObject({
      left: 60,
      top: 12,
    });
  });
});

function createRect({
  left,
  top,
  width,
  height,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRectReadOnly {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => "",
  } satisfies DOMRectReadOnly;
}
