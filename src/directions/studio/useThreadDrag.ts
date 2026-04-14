import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { resolvePaneDrop } from "../../stores/pane-drop-resolver";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { useThreadDragStore } from "./useThreadDragStore";

const ACTIVATION_DISTANCE = 8;

type Session = {
  pointerId: number;
  startX: number;
  startY: number;
  activated: boolean;
};

export type ThreadDragHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onClick: () => void;
};

export function useThreadDrag(
  threadId: string,
  threadTitle: string,
  onClick?: () => void,
): ThreadDragHandlers {
  const sessionRef = useRef<Session | null>(null);
  const suppressClickRef = useRef(false);

  function releaseCapture(event: ReactPointerEvent<HTMLElement>) {
    const element = event.currentTarget;
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    // Reset the suppression flag so a prior cancelled drag doesn't swallow the
    // next real click on this row.
    suppressClickRef.current = false;
    sessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      activated: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLElement>) {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    if (!session.activated) {
      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (Math.hypot(dx, dy) < ACTIVATION_DISTANCE) return;
      session.activated = true;
      suppressClickRef.current = true;
      useThreadDragStore
        .getState()
        .start(threadId, threadTitle, event.clientX, event.clientY);
    }

    const plan = computeDropPlanAt(event.clientX, event.clientY);
    useThreadDragStore
      .getState()
      .updatePointer(event.clientX, event.clientY, plan);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLElement>) {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    sessionRef.current = null;
    releaseCapture(event);

    if (!session.activated) {
      return;
    }

    const plan = useThreadDragStore.getState().dropPlan;
    useThreadDragStore.getState().end();
    if (plan) {
      useWorkspaceStore.getState().applyDropPlan(plan, threadId);
    }
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLElement>) {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    sessionRef.current = null;
    releaseCapture(event);
    // Cancelled drags must not commit whatever plan happened to be hovered —
    // only tear down the drag state so the thread stays where it was.
    if (session.activated) {
      useThreadDragStore.getState().end();
    }
  }

  function handleClick() {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onClick?.();
  }

  return {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerCancel,
    onClick: handleClick,
  };
}

function computeDropPlanAt(x: number, y: number) {
  const element = document.elementFromPoint(x, y);
  if (!element) return null;
  const container = element.closest<HTMLElement>(
    '[data-drop-zone="container"]',
  );
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const relX = (x - rect.left) / rect.width;
  const relY = (y - rect.top) / rect.height;
  const { slots, rowRatio, colRatio } = useWorkspaceStore.getState().layout;
  return resolvePaneDrop(slots, rowRatio, colRatio, relX, relY);
}
