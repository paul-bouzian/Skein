export type SidebarDragState =
  | { kind: "project"; projectId: string }
  | { kind: "environment"; projectId: string; environmentId: string };

export function moveItemToIndex(
  ids: string[],
  activeId: string,
  nextIndex: number,
) {
  const currentIndex = ids.indexOf(activeId);
  if (currentIndex === -1) return ids;
  const clampedIndex = Math.max(0, Math.min(nextIndex, ids.length - 1));
  if (currentIndex === clampedIndex) return ids;

  const withoutActive = ids.filter((id) => id !== activeId);
  return insertAt(withoutActive, activeId, clampedIndex);
}

export function listsMatch(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function insertAt(ids: string[], id: string, index: number) {
  const nextIds = [...ids];
  nextIds.splice(index, 0, id);
  return nextIds;
}
