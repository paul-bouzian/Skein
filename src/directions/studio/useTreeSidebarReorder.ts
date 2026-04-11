import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { EnvironmentRecord, ProjectRecord } from "../../lib/types";
import {
  listsMatch,
  moveItemToIndex,
  type SidebarDragState,
} from "./tree-sidebar-reorder";

const DRAG_ACTIVATION_DISTANCE = 4;

type UseTreeSidebarReorderOptions = {
  projects: ProjectRecord[];
  reorderProjects: (projectIds: string[]) => Promise<boolean>;
  reorderWorktreeEnvironments: (
    projectId: string,
    environmentIds: string[],
  ) => Promise<boolean>;
  resetMessages: () => void;
  setActionError: (message: string) => void;
};

type PointerDragSessionBase = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  offsetX: number;
  offsetY: number;
  dragging: boolean;
};

type PointerDragSession =
  | (PointerDragSessionBase & {
      kind: "project";
      projectId: string;
    })
  | (PointerDragSessionBase & {
      kind: "environment";
      projectId: string;
      environmentId: string;
    });

type DragVisualState =
  | ({
      translateX: number;
      translateY: number;
    } & {
      kind: "project";
      projectId: string;
    })
  | ({
      translateX: number;
      translateY: number;
    } & {
      kind: "environment";
      projectId: string;
      environmentId: string;
    });

export function useTreeSidebarReorder({
  projects,
  reorderProjects,
  reorderWorktreeEnvironments,
  resetMessages,
  setActionError,
}: UseTreeSidebarReorderOptions) {
  const [dragState, setDragState] = useState<SidebarDragState | null>(null);
  const [previewProjectIds, setPreviewProjectIds] = useState<string[] | null>(
    null,
  );
  const [previewEnvironmentIdsByProject, setPreviewEnvironmentIdsByProject] =
    useState<Record<string, string[]> | null>(null);
  const [dragVisualState, setDragVisualState] =
    useState<DragVisualState | null>(null);
  const pointerSessionRef = useRef<PointerDragSession | null>(null);
  const dragVisualStateRef = useRef<DragVisualState | null>(null);
  const previewProjectIdsRef = useRef<string[] | null>(null);
  const previewEnvironmentIdsByProjectRef = useRef<Record<string, string[]> | null>(
    null,
  );
  const projectItemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const environmentItemRefs = useRef<Map<string, Map<string, HTMLElement>>>(
    new Map(),
  );
  const suppressClickUntilRef = useRef(0);

  const projectsRef = useRef(projects);
  const reorderProjectsRef = useRef(reorderProjects);
  const reorderWorktreeEnvironmentsRef = useRef(reorderWorktreeEnvironments);
  const resetMessagesRef = useRef(resetMessages);
  const setActionErrorRef = useRef(setActionError);

  projectsRef.current = projects;
  reorderProjectsRef.current = reorderProjects;
  reorderWorktreeEnvironmentsRef.current = reorderWorktreeEnvironments;
  resetMessagesRef.current = resetMessages;
  setActionErrorRef.current = setActionError;

  const orderedProjects = orderRecords(projects, previewProjectIds);

  const setNextDragVisualState = useCallback(
    (nextDragVisualState: DragVisualState | null) => {
      dragVisualStateRef.current = nextDragVisualState;
      setDragVisualState((current) =>
        dragVisualStatesMatch(current, nextDragVisualState)
          ? current
          : nextDragVisualState,
      );
    },
    [],
  );

  const clearDragState = useCallback(() => {
    pointerSessionRef.current = null;
    previewProjectIdsRef.current = null;
    previewEnvironmentIdsByProjectRef.current = null;
    setDragState(null);
    setPreviewProjectIds(null);
    setPreviewEnvironmentIdsByProject(null);
    setNextDragVisualState(null);
  }, [setNextDragVisualState]);

  const syncDragVisualState = useCallback(() => {
    const session = pointerSessionRef.current;
    if (!session?.dragging) {
      setNextDragVisualState(null);
      return;
    }

    setNextDragVisualState(
      buildDragVisualState(
        session,
        dragVisualStateRef.current,
        projectItemRefs.current,
        environmentItemRefs.current,
      ),
    );
  }, [setNextDragVisualState]);

  useLayoutEffect(() => {
    syncDragVisualState();
  }, [
    dragState,
    previewProjectIds,
    previewEnvironmentIdsByProject,
    syncDragVisualState,
  ]);

  useEffect(() => {
    async function persistProjectReorder() {
      const projectIds = projectsRef.current.map((project) => project.id);
      const nextIds = previewProjectIdsRef.current ?? projectIds;

      try {
        if (
          !listsMatch(nextIds, projectIds) &&
          !(await reorderProjectsRef.current(nextIds))
        ) {
          setActionErrorRef.current("Failed to reorder projects");
        }
      } finally {
        clearDragState();
      }
    }

    async function persistWorktreeReorder(projectId: string) {
      const project = findProject(projectsRef.current, projectId);
      if (!project) {
        clearDragState();
        return;
      }

      const currentIds = worktreeEnvironmentIds(project);
      const nextIds =
        previewEnvironmentIdsByProjectRef.current?.[project.id] ?? currentIds;

      try {
        if (
          !listsMatch(nextIds, currentIds) &&
          !(await reorderWorktreeEnvironmentsRef.current(project.id, nextIds))
        ) {
          setActionErrorRef.current("Failed to reorder worktrees");
        }
      } finally {
        clearDragState();
      }
    }

    function handlePointerMove(event: PointerEvent) {
      const session = pointerSessionRef.current;
      if (!session || event.pointerId !== session.pointerId) {
        return;
      }

      session.lastX = event.clientX;
      session.lastY = event.clientY;

      if (!session.dragging) {
        const distance = Math.hypot(
          event.clientX - session.startX,
          event.clientY - session.startY,
        );
        if (distance < DRAG_ACTIVATION_DISTANCE) {
          return;
        }

        session.dragging = true;
        resetMessagesRef.current();

        if (session.kind === "project") {
          setDragState({ kind: "project", projectId: session.projectId });
          setProjectPreview(projectsRef.current.map((project) => project.id));
          setEnvironmentPreviewMap(null);
        } else {
          const project = findProject(projectsRef.current, session.projectId);
          if (!project) {
            clearDragState();
            return;
          }
          setDragState({
            kind: "environment",
            projectId: session.projectId,
            environmentId: session.environmentId,
          });
          setProjectPreview(null);
          setEnvironmentPreviewMap({
            [project.id]: worktreeEnvironmentIds(project),
          });
        }
      }

      pointerSessionRef.current = session;

      if (session.kind === "project") {
        const projectIds =
          previewProjectIdsRef.current ??
          projectsRef.current.map((project) => project.id);
        const nextIds = reorderByPointerPosition(
          projectIds,
          session.projectId,
          projectItemRefs.current,
          event.clientY,
        );
        if (!listsMatch(nextIds, projectIds)) {
          setProjectPreview(nextIds);
        }
      } else {
        const project = findProject(projectsRef.current, session.projectId);
        if (!project) {
          clearDragState();
          return;
        }

        const environmentIds =
          previewEnvironmentIdsByProjectRef.current?.[project.id] ??
          worktreeEnvironmentIds(project);
        const nextIds = reorderByPointerPosition(
          environmentIds,
          session.environmentId,
          environmentItemRefs.current.get(project.id) ?? new Map(),
          event.clientY,
        );

        if (!listsMatch(nextIds, environmentIds)) {
          setEnvironmentPreviewMap({
            ...(previewEnvironmentIdsByProjectRef.current ?? {}),
            [project.id]: nextIds,
          });
        }
      }

      setNextDragVisualState(
        buildDragVisualState(
          session,
          dragVisualStateRef.current,
          projectItemRefs.current,
          environmentItemRefs.current,
        ),
      );
      event.preventDefault();
    }

    function handlePointerCancel(event: PointerEvent) {
      const session = pointerSessionRef.current;
      if (!session || event.pointerId !== session.pointerId) {
        return;
      }
      clearDragState();
    }

    function handlePointerUp(event: PointerEvent) {
      const session = pointerSessionRef.current;
      if (!session || event.pointerId !== session.pointerId) {
        return;
      }

      pointerSessionRef.current = null;
      if (!session.dragging) {
        return;
      }

      suppressClickUntilRef.current = Date.now() + 250;

      if (session.kind === "project") {
        void persistProjectReorder();
      } else {
        void persistWorktreeReorder(session.projectId);
      }
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [clearDragState, setNextDragVisualState]);

  function setProjectPreview(nextProjectIds: string[] | null) {
    previewProjectIdsRef.current = nextProjectIds;
    setPreviewProjectIds(nextProjectIds);
  }

  function setEnvironmentPreviewMap(
    nextEnvironmentIdsByProject: Record<string, string[]> | null,
  ) {
    previewEnvironmentIdsByProjectRef.current = nextEnvironmentIdsByProject;
    setPreviewEnvironmentIdsByProject(nextEnvironmentIdsByProject);
  }

  function orderedWorktreeEnvironments(project: ProjectRecord) {
    return orderRecords(
      worktreeEnvironments(project),
      previewEnvironmentIdsByProject?.[project.id] ?? null,
    );
  }

  function registerProjectItem(projectId: string) {
    return (node: HTMLElement | null) => {
      if (node) {
        projectItemRefs.current.set(projectId, node);
      } else {
        projectItemRefs.current.delete(projectId);
      }
    };
  }

  function registerEnvironmentItem(projectId: string, environmentId: string) {
    return (node: HTMLElement | null) => {
      const refsByEnvironment =
        environmentItemRefs.current.get(projectId) ?? new Map();
      if (node) {
        refsByEnvironment.set(environmentId, node);
        environmentItemRefs.current.set(projectId, refsByEnvironment);
        return;
      }

      refsByEnvironment.delete(environmentId);
      if (refsByEnvironment.size === 0) {
        environmentItemRefs.current.delete(projectId);
        return;
      }
      environmentItemRefs.current.set(projectId, refsByEnvironment);
    };
  }

  function handleProjectPointerDown(
    event: ReactPointerEvent<HTMLElement>,
    projectId: string,
  ) {
    if (shouldIgnorePointerDown(event)) {
      return;
    }

    pointerSessionRef.current = createProjectPointerSession(
      projectId,
      event,
      projectItemRefs.current.get(projectId) ?? event.currentTarget,
    );
    if ("setPointerCapture" in event.currentTarget) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function handleWorktreePointerDown(
    event: ReactPointerEvent<HTMLElement>,
    project: ProjectRecord,
    environmentId: string,
  ) {
    if (shouldIgnorePointerDown(event)) {
      return;
    }

    pointerSessionRef.current = createEnvironmentPointerSession(
      project.id,
      environmentId,
      event,
      environmentItemRefs.current.get(project.id)?.get(environmentId) ??
        event.currentTarget,
    );
    if ("setPointerCapture" in event.currentTarget) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function shouldSuppressClick() {
    return Date.now() < suppressClickUntilRef.current;
  }

  async function handleProjectKeyboardReorder(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    projectId: string,
  ) {
    const projectIds = projectsRef.current.map((project) => project.id);
    const nextIds = keyboardReorder(projectIds, projectId, event.key);
    if (nextIds === projectIds) return;

    event.preventDefault();
    resetMessagesRef.current();
    if (!(await reorderProjectsRef.current(nextIds))) {
      setActionErrorRef.current("Failed to reorder projects");
    }
  }

  async function handleWorktreeKeyboardReorder(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    project: ProjectRecord,
    environmentId: string,
  ) {
    const environmentIds = worktreeEnvironmentIds(project);
    const nextIds = keyboardReorder(environmentIds, environmentId, event.key);
    if (nextIds === environmentIds) return;

    event.preventDefault();
    resetMessagesRef.current();
    if (
      !(await reorderWorktreeEnvironmentsRef.current(project.id, nextIds))
    ) {
      setActionErrorRef.current("Failed to reorder worktrees");
    }
  }

  function projectDragStyle(projectId: string) {
    if (dragVisualState?.kind !== "project") {
      return undefined;
    }
    if (dragVisualState.projectId !== projectId) {
      return undefined;
    }

    return dragVisualStateToStyle(dragVisualState);
  }

  function environmentDragStyle(projectId: string, environmentId: string) {
    if (dragVisualState?.kind !== "environment") {
      return undefined;
    }
    if (
      dragVisualState.projectId !== projectId ||
      dragVisualState.environmentId !== environmentId
    ) {
      return undefined;
    }

    return dragVisualStateToStyle(dragVisualState);
  }

  return {
    dragState,
    orderedProjects,
    orderedWorktreeEnvironments,
    registerProjectItem,
    registerEnvironmentItem,
    handleProjectPointerDown,
    handleWorktreePointerDown,
    handleProjectKeyboardReorder,
    handleWorktreeKeyboardReorder,
    projectDragStyle,
    environmentDragStyle,
    shouldSuppressClick,
  };
}

export function projectGroupClassName(
  project: ProjectRecord,
  selectedProjectId: string | null,
  dragState: SidebarDragState | null,
) {
  return [
    "project-group",
    project.id === selectedProjectId ? "project-group--selected" : null,
    dragState?.kind === "project" && dragState.projectId === project.id
      ? "project-group--dragging"
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function environmentItemClassName(
  environment: EnvironmentRecord,
  selectedEnvironmentId: string | null,
  dragState: SidebarDragState | null,
) {
  return [
    "environment-item-shell",
    selectedEnvironmentId === environment.id
      ? "environment-item-shell--selected"
      : null,
    dragState?.kind === "environment" &&
    dragState.environmentId === environment.id
      ? "environment-item-shell--dragging"
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function shouldIgnorePointerDown(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0 || !event.isPrimary) {
    return true;
  }

  const target = event.target;
  return (
    target instanceof Element &&
    target.closest("[data-no-reorder-drag='true']") !== null
  );
}

function createProjectPointerSession(
  projectId: string,
  event: ReactPointerEvent<HTMLElement>,
  item: HTMLElement,
): PointerDragSession {
  const rect = item.getBoundingClientRect();
  return {
    kind: "project",
    projectId,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    dragging: false,
  };
}

function createEnvironmentPointerSession(
  projectId: string,
  environmentId: string,
  event: ReactPointerEvent<HTMLElement>,
  item: HTMLElement,
): PointerDragSession {
  const rect = item.getBoundingClientRect();
  return {
    kind: "environment",
    projectId,
    environmentId,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    dragging: false,
  };
}

function buildDragVisualState(
  session: PointerDragSession,
  currentDragVisualState: DragVisualState | null,
  projectItemRefs: Map<string, HTMLElement>,
  environmentItemRefs: Map<string, Map<string, HTMLElement>>,
): DragVisualState | null {
  const draggedElement = draggedElementForSession(
    session,
    projectItemRefs,
    environmentItemRefs,
  );
  if (!draggedElement) {
    return null;
  }

  const rect = draggedElement.getBoundingClientRect();
  const currentTranslate =
    matchingDragVisualState(currentDragVisualState, session)
      ? currentDragVisualState
      : null;
  const baseLeft = rect.left - (currentTranslate?.translateX ?? 0);
  const baseTop = rect.top - (currentTranslate?.translateY ?? 0);
  const translateX = session.lastX - session.offsetX - baseLeft;
  const translateY = session.lastY - session.offsetY - baseTop;

  if (session.kind === "project") {
    return {
      kind: "project",
      projectId: session.projectId,
      translateX,
      translateY,
    };
  }

  return {
    kind: "environment",
    projectId: session.projectId,
    environmentId: session.environmentId,
    translateX,
    translateY,
  };
}

function draggedElementForSession(
  session: PointerDragSession,
  projectItemRefs: Map<string, HTMLElement>,
  environmentItemRefs: Map<string, Map<string, HTMLElement>>,
) {
  if (session.kind === "project") {
    return projectItemRefs.get(session.projectId) ?? null;
  }

  return (
    environmentItemRefs
      .get(session.projectId)
      ?.get(session.environmentId) ?? null
  );
}

function dragVisualStateToStyle(
  dragVisualState: DragVisualState,
): CSSProperties {
  return {
    transform: `translate3d(${dragVisualState.translateX}px, ${dragVisualState.translateY}px, 0)`,
  };
}

function matchingDragVisualState(
  dragVisualState: DragVisualState | null,
  session: PointerDragSession,
) {
  if (!dragVisualState || dragVisualState.kind !== session.kind) {
    return false;
  }

  if (dragVisualState.projectId !== session.projectId) {
    return false;
  }

  if (session.kind === "project") {
    return true;
  }

  return (
    dragVisualState.kind === "environment" &&
    dragVisualState.environmentId === session.environmentId
  );
}

function dragVisualStatesMatch(
  left: DragVisualState | null,
  right: DragVisualState | null,
) {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }

  if (
    left.translateX !== right.translateX ||
    left.translateY !== right.translateY ||
    left.projectId !== right.projectId
  ) {
    return false;
  }

  if (left.kind === "project") {
    return true;
  }

  return (
    right.kind === "environment" && left.environmentId === right.environmentId
  );
}

function reorderByPointerPosition(
  ids: string[],
  activeId: string,
  itemRefs: Map<string, HTMLElement>,
  clientY: number,
) {
  if (ids.length <= 1) {
    return ids;
  }

  const remainingIds = ids.filter((id) => id !== activeId);
  let nextIndex = remainingIds.length;

  for (const [index, id] of remainingIds.entries()) {
    const item = itemRefs.get(id);
    if (!item) {
      continue;
    }
    const rect = item.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      nextIndex = index;
      break;
    }
  }

  return moveItemToIndex(ids, activeId, nextIndex);
}

function keyboardReorder(ids: string[], activeId: string, key: string) {
  const currentIndex = ids.indexOf(activeId);
  if (currentIndex === -1) return ids;

  if (key === "ArrowUp") {
    return moveItemToIndex(ids, activeId, currentIndex - 1);
  }
  if (key === "ArrowDown") {
    return moveItemToIndex(ids, activeId, currentIndex + 1);
  }
  if (key === "Home") {
    return moveItemToIndex(ids, activeId, 0);
  }
  if (key === "End") {
    return moveItemToIndex(ids, activeId, ids.length - 1);
  }
  return ids;
}

function findProject(projects: ProjectRecord[], projectId: string) {
  return projects.find((project) => project.id === projectId) ?? null;
}

function worktreeEnvironmentIds(project: ProjectRecord) {
  return worktreeEnvironments(project).map((environment) => environment.id);
}

function worktreeEnvironments(project: ProjectRecord) {
  return project.environments.filter(
    (environment) => environment.kind !== "local",
  );
}

function orderRecords<T extends { id: string }>(
  records: T[],
  orderedIds: string[] | null,
) {
  if (!orderedIds) return records;

  const recordsById = new Map(records.map((record) => [record.id, record]));
  const orderedRecords: T[] = [];
  for (const id of orderedIds) {
    const record = recordsById.get(id);
    if (!record) return records;
    orderedRecords.push(record);
  }

  return orderedRecords.length === records.length ? orderedRecords : records;
}
