import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SIDEBAR_PANEL_MAX_WIDTH,
  SIDEBAR_PANEL_MIN_WIDTH,
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
} from "../../stores/side-panel-store";
import { SidePanelResizer } from "./SidePanelResizer";

describe("SidePanelResizer", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty("--tx-side-panel-width");
    document.documentElement.style.removeProperty("--tx-sidebar-width");
  });

  function renderAt(width = 420, side: "left" | "right" = "right") {
    const onResize = vi.fn();
    const onDraggingChange = vi.fn();
    const utils = render(
      <SidePanelResizer
        side={side}
        width={width}
        onResize={onResize}
        onDraggingChange={onDraggingChange}
      />,
    );
    const handle = utils.container.querySelector(
      ".side-panel-resizer",
    ) as HTMLDivElement;
    return { handle, onResize, onDraggingChange };
  }

  it("renders a separator with aria attributes", () => {
    const { handle } = renderAt(420);
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("420");
    expect(handle.getAttribute("aria-valuemin")).toBe(String(SIDE_PANEL_MIN_WIDTH));
    expect(handle.getAttribute("aria-valuemax")).toBe(String(SIDE_PANEL_MAX_WIDTH));
  });

  it("renders left sidebar bounds when configured for the projects sidebar", () => {
    const { handle } = renderAt(256, "left");
    expect(handle).toHaveAttribute("aria-label", "Resize projects sidebar");
    expect(handle.getAttribute("aria-valuenow")).toBe("256");
    expect(handle.getAttribute("aria-valuemin")).toBe(String(SIDEBAR_PANEL_MIN_WIDTH));
    expect(handle.getAttribute("aria-valuemax")).toBe(String(SIDEBAR_PANEL_MAX_WIDTH));
  });

  it("pointer drag left grows the panel and commits on pointer up", () => {
    const { handle, onResize, onDraggingChange } = renderAt(420);
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 1000 });
    expect(onDraggingChange).toHaveBeenLastCalledWith(true);

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
    // No commit yet during drag.
    expect(onResize).not.toHaveBeenCalled();
    // CSS var updated.
    expect(
      document.documentElement.style.getPropertyValue("--tx-side-panel-width"),
    ).toBe("520px");

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 900 });
    expect(onResize).toHaveBeenCalledWith(520);
    expect(onDraggingChange).toHaveBeenLastCalledWith(false);
  });

  it("clamps drag to max width", () => {
    const { handle, onResize } = renderAt(500);
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 1000 });
    // Drag far to the left.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 0 });
    expect(onResize).toHaveBeenCalledWith(SIDE_PANEL_MAX_WIDTH);
  });

  it("keyboard ArrowLeft grows panel", () => {
    const { handle, onResize } = renderAt(420);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenCalledWith(436);
  });

  it("keyboard ArrowRight shrinks panel", () => {
    const { handle, onResize } = renderAt(420);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onResize).toHaveBeenCalledWith(404);
  });

  it("keyboard Home snaps to max", () => {
    const { handle, onResize } = renderAt(420);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(onResize).toHaveBeenCalledWith(SIDE_PANEL_MAX_WIDTH);
  });

  it("keyboard End snaps to min", () => {
    const { handle, onResize } = renderAt(420);
    fireEvent.keyDown(handle, { key: "End" });
    expect(onResize).toHaveBeenCalledWith(SIDE_PANEL_MIN_WIDTH);
  });

  it("pointer drag right grows the left sidebar and commits on pointer up", () => {
    const { handle, onResize, onDraggingChange } = renderAt(256, "left");
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 260 });
    expect(onDraggingChange).toHaveBeenLastCalledWith(true);

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 320 });
    expect(onResize).not.toHaveBeenCalled();
    expect(
      document.documentElement.style.getPropertyValue("--tx-sidebar-width"),
    ).toBe("316px");

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 320 });
    expect(onResize).toHaveBeenCalledWith(316);
    expect(onDraggingChange).toHaveBeenLastCalledWith(false);
  });

  it("clamps left sidebar drag to max width", () => {
    const { handle, onResize } = renderAt(300, "left");
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 900 });
    expect(onResize).toHaveBeenCalledWith(SIDEBAR_PANEL_MAX_WIDTH);
  });

  it("left sidebar keyboard ArrowRight grows and ArrowLeft shrinks", () => {
    const { handle, onResize } = renderAt(256, "left");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onResize).toHaveBeenCalledWith(272);

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenCalledWith(240);
  });

  it("left sidebar keyboard Home snaps to min and End snaps to max", () => {
    const { handle, onResize } = renderAt(256, "left");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(onResize).toHaveBeenCalledWith(SIDEBAR_PANEL_MIN_WIDTH);

    fireEvent.keyDown(handle, { key: "End" });
    expect(onResize).toHaveBeenCalledWith(SIDEBAR_PANEL_MAX_WIDTH);
  });
});
