import type {
  PaneDirection,
  PaneSelection,
  SlotKey,
} from "./workspace-store";

export type PaneDropPlan = {
  newSlot: SlotKey;
  direction: PaneDirection;
  updates: Array<{ slot: SlotKey; value: PaneSelection | null }>;
  /**
   * Rectangle (as fractions of the main-content area) where the new pane will
   * be rendered after the drop is applied. Used to animate the Windows-like
   * preview.
   */
  previewRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
};

const SLOT_KEYS: readonly SlotKey[] = [
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomRight",
] as const;

export function resolvePaneDrop(
  slots: Record<SlotKey, PaneSelection | null>,
  rowRatio: number,
  colRatio: number,
  relativeX: number,
  relativeY: number,
): PaneDropPlan | null {
  if (
    relativeX < 0 ||
    relativeX > 1 ||
    relativeY < 0 ||
    relativeY > 1
  ) {
    return null;
  }
  const paneCount = SLOT_KEYS.reduce(
    (sum, key) => sum + (slots[key] ? 1 : 0),
    0,
  );
  if (paneCount >= 4) return null;

  if (paneCount === 0) {
    // Empty layout: any drop seeds the first pane (always topLeft).
    const direction = closestEdge(relativeX, relativeY);
    return {
      newSlot: "topLeft",
      direction,
      updates: [],
      previewRect: { left: 0, top: 0, width: 1, height: 1 },
    };
  }

  const hovered = findHoveredSlot(slots, rowRatio, colRatio, relativeX, relativeY);
  if (!hovered) return null;

  const localX = (relativeX - hovered.rect.left) / hovered.rect.width;
  const localY = (relativeY - hovered.rect.top) / hovered.rect.height;
  const direction = closestEdge(localX, localY);
  const plan = resolveLocalDrop(slots, hovered.slot, direction);
  if (!plan) return null;

  const existingPane = slots[hovered.slot];
  if (!existingPane) return null;
  const nextSlots = applyPlan(slots, plan, existingPane);
  const previewRect = computeSlotRect(
    plan.newSlot,
    nextSlots,
    rowRatio,
    colRatio,
  );
  return {
    newSlot: plan.newSlot,
    direction,
    updates: plan.updates,
    previewRect,
  };
}

function closestEdge(x: number, y: number): PaneDirection {
  const distances: Record<PaneDirection, number> = {
    top: y,
    bottom: 1 - y,
    left: x,
    right: 1 - x,
  };
  let best: PaneDirection = "top";
  let bestDistance = distances.top;
  for (const direction of ["right", "bottom", "left"] as PaneDirection[]) {
    if (distances[direction] < bestDistance) {
      best = direction;
      bestDistance = distances[direction];
    }
  }
  return best;
}

function findHoveredSlot(
  slots: Record<SlotKey, PaneSelection | null>,
  rowRatio: number,
  colRatio: number,
  x: number,
  y: number,
): { slot: SlotKey; rect: ReturnType<typeof computeSlotRect> } | null {
  for (const slot of SLOT_KEYS) {
    if (slots[slot] === null) continue;
    const rect = computeSlotRect(slot, slots, rowRatio, colRatio);
    if (
      x >= rect.left &&
      x <= rect.left + rect.width &&
      y >= rect.top &&
      y <= rect.top + rect.height
    ) {
      return { slot, rect };
    }
  }
  return null;
}

export function computeSlotRect(
  slot: SlotKey,
  slots: Record<SlotKey, PaneSelection | null>,
  rowRatio: number,
  colRatio: number,
): { left: number; top: number; width: number; height: number } {
  const { topLeft: TL, topRight: TR, bottomLeft: BL, bottomRight: BR } = slots;
  const topRowHasPane = TL !== null || TR !== null;
  const bottomRowHasPane = BL !== null || BR !== null;
  const bothRows = topRowHasPane && bottomRowHasPane;

  const topRowY = 0;
  const topRowHeight = bothRows ? rowRatio : topRowHasPane ? 1 : 0;
  const bottomRowY = bothRows ? rowRatio : 0;
  const bottomRowHeight = bothRows ? 1 - rowRatio : bottomRowHasPane ? 1 : 0;

  const isTop = slot === "topLeft" || slot === "topRight";
  const rowTL = isTop ? TL : BL;
  const rowTR = isTop ? TR : BR;
  const bothCols = rowTL !== null && rowTR !== null;

  const leftColX = 0;
  const leftColWidth = bothCols ? colRatio : rowTL !== null ? 1 : 0;
  const rightColX = bothCols ? colRatio : 0;
  const rightColWidth = bothCols ? 1 - colRatio : rowTR !== null ? 1 : 0;

  const isLeft = slot === "topLeft" || slot === "bottomLeft";
  return {
    left: isLeft ? leftColX : rightColX,
    width: isLeft ? leftColWidth : rightColWidth,
    top: isTop ? topRowY : bottomRowY,
    height: isTop ? topRowHeight : bottomRowHeight,
  };
}

type LocalPlan = {
  newSlot: SlotKey;
  updates: Array<{ slot: SlotKey; value: PaneSelection | null }>;
};

function resolveLocalDrop(
  slots: Record<SlotKey, PaneSelection | null>,
  anchor: SlotKey,
  direction: PaneDirection,
): LocalPlan | null {
  const pane = slots[anchor];
  if (!pane) return null;
  const rs = computeRowSpan(anchor, slots);
  const cs = computeColSpan(anchor, slots);

  if (rs === 1 && cs === 1) {
    // Anchor is in a single slot — push to neighbor if free.
    const target = neighborSlot(anchor, direction);
    if (!target) return null;
    if (slots[target] !== null) return null;
    return { newSlot: target, updates: [] };
  }

  if (rs === 1 && cs === 2) {
    // Row-spanning: anchor's row has only this pane.
    return resolveRowSpanningDrop(slots, anchor, direction, pane);
  }

  if (rs === 2 && cs === 1) {
    // Col-spanning: anchor's column has only this pane.
    return resolveColSpanningDrop(slots, anchor, direction, pane);
  }

  // Full-spanning: the only pane in the layout (count=1). Any direction splits.
  switch (direction) {
    case "top":
      return {
        newSlot: "topLeft",
        updates: [{ slot: "bottomLeft", value: pane }],
      };
    case "bottom":
      return { newSlot: "bottomLeft", updates: [] };
    case "left":
      return {
        newSlot: "topLeft",
        updates: [{ slot: "topRight", value: pane }],
      };
    case "right":
      return { newSlot: "topRight", updates: [] };
  }
}

function resolveRowSpanningDrop(
  slots: Record<SlotKey, PaneSelection | null>,
  anchor: SlotKey,
  direction: PaneDirection,
  pane: PaneSelection,
): LocalPlan | null {
  const anchorTop = anchor === "topLeft" || anchor === "topRight";
  const anchorLeft = anchor === "topLeft" || anchor === "bottomLeft";
  const sameRowOtherCol = sameRowOppositeSlot(anchor);

  switch (direction) {
    case "left":
      if (anchorLeft) {
        // new takes the left slot (anchor's position). Pane moves to right.
        return {
          newSlot: anchor,
          updates: [{ slot: sameRowOtherCol, value: pane }],
        };
      }
      // Anchor is at right slot → new goes to its left (the opposite col).
      return { newSlot: sameRowOtherCol, updates: [] };
    case "right":
      if (!anchorLeft) {
        return {
          newSlot: anchor,
          updates: [{ slot: sameRowOtherCol, value: pane }],
        };
      }
      return { newSlot: sameRowOtherCol, updates: [] };
    case "top":
    case "bottom": {
      const wantTopRow = direction === "top";
      if (wantTopRow === anchorTop) return null;
      const neighbors: SlotKey[] = wantTopRow
        ? ["topLeft", "topRight"]
        : ["bottomLeft", "bottomRight"];
      // Only accept if the entire target row is empty — pushing a row-spanning
      // pane needs a clean row, otherwise the drop would create an awkward mix.
      const allEmpty = neighbors.every((slot) => slots[slot] === null);
      if (!allEmpty) return null;
      return { newSlot: neighbors[0]!, updates: [] };
    }
  }
}

function resolveColSpanningDrop(
  slots: Record<SlotKey, PaneSelection | null>,
  anchor: SlotKey,
  direction: PaneDirection,
  pane: PaneSelection,
): LocalPlan | null {
  const anchorTop = anchor === "topLeft" || anchor === "topRight";
  const anchorLeft = anchor === "topLeft" || anchor === "bottomLeft";
  const sameColOtherRow = sameColOppositeSlot(anchor);

  switch (direction) {
    case "top":
      if (anchorTop) {
        return {
          newSlot: anchor,
          updates: [{ slot: sameColOtherRow, value: pane }],
        };
      }
      return { newSlot: sameColOtherRow, updates: [] };
    case "bottom":
      if (!anchorTop) {
        return {
          newSlot: anchor,
          updates: [{ slot: sameColOtherRow, value: pane }],
        };
      }
      return { newSlot: sameColOtherRow, updates: [] };
    case "left":
    case "right": {
      const wantLeftCol = direction === "left";
      if (wantLeftCol === anchorLeft) return null;
      const neighbors: SlotKey[] = wantLeftCol
        ? ["topLeft", "bottomLeft"]
        : ["topRight", "bottomRight"];
      // A col-spanning pane cannot cleanly share its target column with
      // another pane — only accept when the whole col is empty.
      const allEmpty = neighbors.every((slot) => slots[slot] === null);
      if (!allEmpty) return null;
      return { newSlot: neighbors[0]!, updates: [] };
    }
  }
}

function computeRowSpan(
  slot: SlotKey,
  slots: Record<SlotKey, PaneSelection | null>,
): 1 | 2 {
  const isTop = slot === "topLeft" || slot === "topRight";
  const opposite: SlotKey[] = isTop
    ? ["bottomLeft", "bottomRight"]
    : ["topLeft", "topRight"];
  const oppositeEmpty = opposite.every((key) => slots[key] === null);
  return oppositeEmpty ? 2 : 1;
}

function computeColSpan(
  slot: SlotKey,
  slots: Record<SlotKey, PaneSelection | null>,
): 1 | 2 {
  return slots[sameRowOppositeSlot(slot)] === null ? 2 : 1;
}

function sameRowOppositeSlot(slot: SlotKey): SlotKey {
  switch (slot) {
    case "topLeft":
      return "topRight";
    case "topRight":
      return "topLeft";
    case "bottomLeft":
      return "bottomRight";
    case "bottomRight":
      return "bottomLeft";
  }
}

function sameColOppositeSlot(slot: SlotKey): SlotKey {
  switch (slot) {
    case "topLeft":
      return "bottomLeft";
    case "bottomLeft":
      return "topLeft";
    case "topRight":
      return "bottomRight";
    case "bottomRight":
      return "topRight";
  }
}

function neighborSlot(slot: SlotKey, direction: PaneDirection): SlotKey | null {
  switch (slot) {
    case "topLeft":
      switch (direction) {
        case "top":
          return null;
        case "left":
          return null;
        case "right":
          return "topRight";
        case "bottom":
          return "bottomLeft";
      }
      return null;
    case "topRight":
      switch (direction) {
        case "top":
          return null;
        case "right":
          return null;
        case "left":
          return "topLeft";
        case "bottom":
          return "bottomRight";
      }
      return null;
    case "bottomLeft":
      switch (direction) {
        case "bottom":
          return null;
        case "left":
          return null;
        case "right":
          return "bottomRight";
        case "top":
          return "topLeft";
      }
      return null;
    case "bottomRight":
      switch (direction) {
        case "bottom":
          return null;
        case "right":
          return null;
        case "left":
          return "bottomLeft";
        case "top":
          return "topRight";
      }
      return null;
  }
}

function applyPlan(
  slots: Record<SlotKey, PaneSelection | null>,
  plan: LocalPlan,
  newPane: PaneSelection,
): Record<SlotKey, PaneSelection | null> {
  const next = { ...slots };
  for (const update of plan.updates) {
    next[update.slot] = update.value;
  }
  next[plan.newSlot] = newPane;
  return next;
}
