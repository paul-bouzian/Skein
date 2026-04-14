import { create } from "zustand";

import type { PaneDropPlan } from "../../stores/pane-drop-resolver";

type ThreadDragState = {
  isDragging: boolean;
  threadId: string | null;
  threadTitle: string;
  pointerX: number;
  pointerY: number;
  dropPlan: PaneDropPlan | null;
  start: (
    threadId: string,
    threadTitle: string,
    x: number,
    y: number,
  ) => void;
  updatePointer: (
    x: number,
    y: number,
    plan: PaneDropPlan | null,
  ) => void;
  end: () => void;
};

export const useThreadDragStore = create<ThreadDragState>((set) => ({
  isDragging: false,
  threadId: null,
  threadTitle: "",
  pointerX: 0,
  pointerY: 0,
  dropPlan: null,
  start: (threadId, threadTitle, x, y) =>
    set({
      isDragging: true,
      threadId,
      threadTitle,
      pointerX: x,
      pointerY: y,
      dropPlan: null,
    }),
  updatePointer: (x, y, plan) =>
    set({ pointerX: x, pointerY: y, dropPlan: plan }),
  end: () =>
    set({
      isDragging: false,
      threadId: null,
      threadTitle: "",
      dropPlan: null,
    }),
}));
