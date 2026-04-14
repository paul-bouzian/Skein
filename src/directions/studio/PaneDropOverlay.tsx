import { createPortal } from "react-dom";

import { ThreadIcon } from "../../shared/Icons";
import type { PaneDirection } from "../../stores/workspace-store";
import { useThreadDragStore } from "./useThreadDragStore";
import "./PaneDropOverlay.css";

export function PaneDropOverlay() {
  const isDragging = useThreadDragStore((s) => s.isDragging);
  const plan = useThreadDragStore((s) => s.dropPlan);

  if (!isDragging) return null;

  const previewStyle = plan
    ? {
        left: `${plan.previewRect.left * 100}%`,
        top: `${plan.previewRect.top * 100}%`,
        width: `${plan.previewRect.width * 100}%`,
        height: `${plan.previewRect.height * 100}%`,
      }
    : null;

  return (
    <div
      className="pane-drop-overlay"
      data-drop-zone="container"
      aria-hidden="true"
    >
      {previewStyle && plan && (
        <div className="pane-drop-overlay__preview" style={previewStyle}>
          <span className="pane-drop-overlay__label">
            {labelForDirection(plan.direction)}
          </span>
        </div>
      )}
    </div>
  );
}

export function ThreadDragGhost() {
  const isDragging = useThreadDragStore((s) => s.isDragging);
  const title = useThreadDragStore((s) => s.threadTitle);
  const x = useThreadDragStore((s) => s.pointerX);
  const y = useThreadDragStore((s) => s.pointerY);

  if (!isDragging) return null;

  return createPortal(
    <div
      className="thread-drag-ghost"
      style={{ transform: `translate(${x + 12}px, ${y + 12}px)` }}
    >
      <ThreadIcon size={12} />
      <span className="thread-drag-ghost__title">{title}</span>
    </div>,
    document.body,
  );
}

function labelForDirection(direction: PaneDirection): string {
  switch (direction) {
    case "top":
      return "Split top";
    case "bottom":
      return "Split bottom";
    case "left":
      return "Split left";
    case "right":
      return "Split right";
  }
}
