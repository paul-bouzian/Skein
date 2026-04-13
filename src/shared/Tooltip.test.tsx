import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Tooltip } from "./Tooltip";

const ORIGINAL_VIEWPORT = {
  width: window.innerWidth,
  height: window.innerHeight,
};

describe("Tooltip", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setViewportSize(ORIGINAL_VIEWPORT.width, ORIGINAL_VIEWPORT.height);
  });

  it("keeps the tooltip fully visible near the left viewport edge", async () => {
    setViewportSize(320, 240);
    mockTooltipLayout({
      anchorRect: createRect({ left: 4, top: 100, width: 24, height: 24 }),
      tooltipRect: createRect({ left: 0, top: 0, width: 140, height: 32 }),
    });

    render(
      <Tooltip content="Open pull request #59: notifications: add desktop and sound alerts" delay={0}>
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    const user = userEvent.setup();

    await user.hover(screen.getByRole("button", { name: "Trigger" }));

    const tooltip = await screen.findByRole("tooltip");
    await waitFor(() => {
      expect(tooltip).toHaveStyle({
        left: "12px",
        top: "62px",
        visibility: "visible",
      });
    });
  });

  it("recomputes its position when the viewport changes while open", async () => {
    setViewportSize(320, 240);
    mockTooltipLayout({
      anchorRect: createRect({ left: 150, top: 100, width: 40, height: 20 }),
      tooltipRect: createRect({ left: 0, top: 0, width: 140, height: 32 }),
    });

    render(
      <Tooltip content="Fast mode" side="bottom" delay={0}>
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    const user = userEvent.setup();

    await user.hover(screen.getByRole("button", { name: "Trigger" }));

    const tooltip = await screen.findByRole("tooltip");
    await waitFor(() => {
      expect(tooltip).toHaveStyle({
        left: "100px",
        top: "126px",
      });
    });

    setViewportSize(180, 240);
    window.dispatchEvent(new Event("resize"));

    await waitFor(() => {
      expect(tooltip).toHaveStyle({
        left: "28px",
        top: "126px",
      });
    });
  });

  it("recomputes its position when the reposition key changes while open", async () => {
    setViewportSize(320, 240);
    let anchorRect = createRect({ left: 150, top: 100, width: 40, height: 20 });
    mockTooltipLayout({
      getAnchorRect: () => anchorRect,
      tooltipRect: createRect({ left: 0, top: 0, width: 140, height: 32 }),
    });

    const { rerender } = render(
      <Tooltip content="Fast mode" delay={0} repositionKey="initial">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    const user = userEvent.setup();

    await user.hover(screen.getByRole("button", { name: "Trigger" }));

    const tooltip = await screen.findByRole("tooltip");
    await waitFor(() => {
      expect(tooltip).toHaveStyle({
        left: "100px",
        top: "62px",
      });
    });

    anchorRect = createRect({ left: 24, top: 100, width: 24, height: 24 });
    rerender(
      <Tooltip content="Fast mode" delay={0} repositionKey="updated">
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    await waitFor(() => {
      expect(tooltip).toHaveStyle({
        left: "12px",
        top: "62px",
      });
    });
  });
});

function setViewportSize(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
    writable: true,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: height,
    writable: true,
  });
}

function mockTooltipLayout({
  anchorRect,
  getAnchorRect,
  tooltipRect,
}: {
  anchorRect?: DOMRectReadOnly;
  getAnchorRect?: () => DOMRectReadOnly;
  tooltipRect: DOMRectReadOnly;
}) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("tx-tooltip-anchor")) {
      return getAnchorRect ? getAnchorRect() : anchorRect!;
    }
    if (this.classList.contains("tx-tooltip")) {
      return tooltipRect;
    }
    return createRect({ left: 0, top: 0, width: 0, height: 0 });
  });
}

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
