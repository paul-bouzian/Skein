import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";

import {
  selectHasAnyPane,
  selectLayout,
  selectSelectedEnvironment,
  selectSelectedProject,
  selectSettings,
  useWorkspaceStore,
  type SlotKey,
  type WorkspaceLayout,
} from "../../stores/workspace-store";
import {
  selectHasAnyTerminalTabs,
  selectTerminalSlot,
  useTerminalStore,
} from "../../stores/terminal-store";
import { PanelLeftIcon, PanelRightIcon, TerminalIcon } from "../../shared/Icons";
import { Tooltip } from "../../shared/Tooltip";
import { EnvironmentActionControl } from "./EnvironmentActionControl";
import { OpenEnvironmentControl } from "./OpenEnvironmentControl";
import { PaneDropOverlay, ThreadDragGhost } from "./PaneDropOverlay";
import { PaneSplitter } from "./PaneSplitter";
import { DefaultStudioView, StudioPane } from "./StudioPane";
import { TerminalPanel } from "./TerminalPanel";
import type { Theme } from "./StudioShell";
import "./StudioMain.css";

const NOOP = () => undefined;

type Props = {
  theme: Theme;
  projectsSidebarOpen: boolean;
  inspectorOpen: boolean;
  composerFocusKey: number;
  approveOrSubmitKey: number;
  onOpenActionCreateDialog?: () => void;
  onToggleProjectsSidebar: () => void;
  onToggleInspector: () => void;
};

export function StudioMain({
  theme,
  projectsSidebarOpen,
  inspectorOpen,
  composerFocusKey,
  approveOrSubmitKey,
  onOpenActionCreateDialog = NOOP,
  onToggleProjectsSidebar,
  onToggleInspector,
}: Props) {
  const selectedProject = useWorkspaceStore(selectSelectedProject);
  const selectedEnvironment = useWorkspaceStore(selectSelectedEnvironment);
  const settings = useWorkspaceStore(selectSettings);
  const layout = useWorkspaceStore(selectLayout);
  const hasAnyPane = useWorkspaceStore(selectHasAnyPane);
  const setRowRatio = useWorkspaceStore((state) => state.setRowRatio);
  const setColRatio = useWorkspaceStore((state) => state.setColRatio);
  const selectedEnvironmentId = selectedEnvironment?.id ?? null;
  const terminalSlot = useTerminalStore(selectTerminalSlot(selectedEnvironmentId));
  const hasAnyTerminalTabs = useTerminalStore(selectHasAnyTerminalTabs);

  const toggleTerminal = useTerminalStore((s) => s.toggleVisible);
  const setTerminalHeight = useTerminalStore((s) => s.setHeight);
  const terminalVisible = selectedEnvironmentId != null && terminalSlot.visible;
  const terminalHeight = terminalSlot.height;
  const terminalMounted = terminalVisible || hasAnyTerminalTabs;
  const [terminalDragging, setTerminalDragging] = useState(false);
  const [splitDragging, setSplitDragging] = useState(false);

  useEffect(() => {
    if (!terminalVisible) {
      setTerminalDragging(false);
    }
  }, [terminalVisible]);

  return (
    <main
      className={`studio-main${terminalDragging ? " studio-main--resizing" : ""}${splitDragging ? " studio-main--split-resizing" : ""}`}
    >
      <div className="studio-main__toolbar">
        <div className="studio-main__toolbar-primary">
          <Tooltip
            content={projectsSidebarOpen ? "Hide sidebar" : "Show sidebar"}
            side="bottom"
          >
            <button
              type="button"
              aria-label={projectsSidebarOpen ? "Hide sidebar" : "Show sidebar"}
              className={`studio-main__toggle-sidebar ${projectsSidebarOpen ? "studio-main__toggle-sidebar--active" : ""}`}
              onClick={onToggleProjectsSidebar}
            >
              <PanelLeftIcon size={14} />
            </button>
          </Tooltip>
        </div>
        <div className="studio-main__toolbar-actions">
          <EnvironmentActionControl
            environmentId={selectedEnvironment?.id ?? null}
            projectId={selectedProject?.id ?? null}
            actions={selectedProject?.settings.manualActions ?? []}
            onAddAction={onOpenActionCreateDialog}
          />
          <OpenEnvironmentControl
            environmentId={selectedEnvironment?.id ?? null}
            settings={settings}
          />
          <Tooltip
            content={
              !selectedEnvironmentId
                ? "Select a worktree first"
                : terminalVisible
                  ? "Hide terminal"
                  : "Show terminal"
            }
            side="bottom"
          >
            <button
              type="button"
              aria-label={
                !selectedEnvironmentId
                  ? "Select a worktree first"
                  : terminalVisible
                    ? "Hide terminal"
                    : "Show terminal"
              }
              className={`studio-main__toggle-terminal ${terminalVisible ? "studio-main__toggle-terminal--active" : ""}`}
              disabled={!selectedEnvironmentId}
              onClick={() => {
                if (!selectedEnvironmentId) {
                  return;
                }
                toggleTerminal(selectedEnvironmentId);
              }}
            >
              <TerminalIcon size={14} />
            </button>
          </Tooltip>
          <Tooltip
            content={inspectorOpen ? "Hide inspector" : "Show inspector"}
            side="bottom"
          >
            <button
              type="button"
              aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
              className={`studio-main__toggle-inspector ${inspectorOpen ? "studio-main__toggle-inspector--active" : ""}`}
              onClick={onToggleInspector}
            >
              <PanelRightIcon size={14} />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="studio-main__content">
        {hasAnyPane ? (
          <StudioLayout
            layout={layout}
            composerFocusKey={composerFocusKey}
            approveOrSubmitKey={approveOrSubmitKey}
            onRowRatioChange={setRowRatio}
            onColRatioChange={setColRatio}
            onSplitDragChange={setSplitDragging}
          />
        ) : (
          <div className="studio-main__pane studio-main__pane--default">
            <div className="studio-main__pane-scroll">
              <DefaultStudioView />
            </div>
          </div>
        )}
        <PaneDropOverlay />
      </div>
      <ThreadDragGhost />
      {terminalVisible && selectedEnvironmentId && (
        <TerminalResizeHandle
          environmentId={selectedEnvironmentId}
          initialHeight={terminalHeight}
          onDraggingChange={setTerminalDragging}
          onResize={setTerminalHeight}
        />
      )}
      {terminalMounted && (
        <div
          className={`studio-main__terminal ${terminalVisible ? "" : "studio-main__terminal--hidden"}`}
          style={{ height: terminalVisible ? terminalHeight : undefined }}
          inert={!terminalVisible || undefined}
        >
          <TerminalPanel theme={theme} />
        </div>
      )}
    </main>
  );
}

type StudioLayoutProps = {
  layout: WorkspaceLayout;
  composerFocusKey: number;
  approveOrSubmitKey: number;
  onRowRatioChange: (ratio: number) => void;
  onColRatioChange: (ratio: number) => void;
  onSplitDragChange: (dragging: boolean) => void;
};

function StudioLayout({
  layout,
  composerFocusKey,
  approveOrSubmitKey,
  onRowRatioChange,
  onColRatioChange,
  onSplitDragChange,
}: StudioLayoutProps) {
  const { slots, rowRatio, colRatio } = layout;
  const hasTop = slots.topLeft !== null || slots.topRight !== null;
  const hasBottom = slots.bottomLeft !== null || slots.bottomRight !== null;
  const gridRef = useRef<HTMLDivElement>(null);

  // Sync split ratios as CSS variables on the grid root. Panes/rows/cells
  // read these via `calc(var(...))` so the splitter can update them
  // imperatively during a drag without triggering a React re-render.
  useLayoutEffect(() => {
    gridRef.current?.style.setProperty("--studio-row-ratio", String(rowRatio));
  }, [rowRatio]);
  useLayoutEffect(() => {
    gridRef.current?.style.setProperty("--studio-col-ratio", String(colRatio));
  }, [colRatio]);

  return (
    <div ref={gridRef} className="studio-main__grid">
      {hasTop && (
        <StudioRow
          leftSlot="topLeft"
          rightSlot="topRight"
          slots={slots}
          sharesHeight={hasBottom}
          position="top"
          colRatio={colRatio}
          composerFocusKey={composerFocusKey}
          approveOrSubmitKey={approveOrSubmitKey}
          onColRatioChange={onColRatioChange}
          onSplitDragChange={onSplitDragChange}
        />
      )}
      {hasTop && hasBottom && (
        <PaneSplitter
          orientation="column"
          ratio={rowRatio}
          onCommit={onRowRatioChange}
          onDraggingChange={onSplitDragChange}
        />
      )}
      {hasBottom && (
        <StudioRow
          leftSlot="bottomLeft"
          rightSlot="bottomRight"
          slots={slots}
          sharesHeight={hasTop}
          position="bottom"
          colRatio={colRatio}
          composerFocusKey={composerFocusKey}
          approveOrSubmitKey={approveOrSubmitKey}
          onColRatioChange={onColRatioChange}
          onSplitDragChange={onSplitDragChange}
        />
      )}
    </div>
  );
}

type StudioRowProps = {
  leftSlot: SlotKey;
  rightSlot: SlotKey;
  slots: WorkspaceLayout["slots"];
  sharesHeight: boolean;
  position: "top" | "bottom";
  colRatio: number;
  composerFocusKey: number;
  approveOrSubmitKey: number;
  onColRatioChange: (ratio: number) => void;
  onSplitDragChange: (dragging: boolean) => void;
};

// Stable style strings: React never re-renders on split-ratio changes because
// the live value is read from CSS variables on `.studio-main__grid`.
const ROW_FLEX_SHARED_TOP = "0 0 calc(var(--studio-row-ratio, 0.5) * 100%)";
const CELL_FLEX_SHARED_LEFT = "0 0 calc(var(--studio-col-ratio, 0.5) * 100%)";
const FLEX_FILL = "1 1 0%";

function StudioRow({
  leftSlot,
  rightSlot,
  slots,
  sharesHeight,
  position,
  colRatio,
  composerFocusKey,
  approveOrSubmitKey,
  onColRatioChange,
  onSplitDragChange,
}: StudioRowProps) {
  const hasLeft = slots[leftSlot] !== null;
  const hasRight = slots[rightSlot] !== null;
  const rowFlex =
    sharesHeight && position === "top" ? ROW_FLEX_SHARED_TOP : FLEX_FILL;
  const leftFlex = hasRight ? CELL_FLEX_SHARED_LEFT : FLEX_FILL;

  return (
    <div className="studio-main__grid-row" style={{ flex: rowFlex }}>
      {hasLeft && (
        <div className="studio-main__grid-cell" style={{ flex: leftFlex }}>
          <StudioPane
            paneId={leftSlot}
            composerFocusKey={composerFocusKey}
            approveOrSubmitKey={approveOrSubmitKey}
          />
        </div>
      )}
      {hasLeft && hasRight && (
        <PaneSplitter
          orientation="row"
          ratio={colRatio}
          onCommit={onColRatioChange}
          onDraggingChange={onSplitDragChange}
        />
      )}
      {hasRight && (
        <div className="studio-main__grid-cell" style={{ flex: FLEX_FILL }}>
          <StudioPane
            paneId={rightSlot}
            composerFocusKey={composerFocusKey}
            approveOrSubmitKey={approveOrSubmitKey}
          />
        </div>
      )}
    </div>
  );
}

function TerminalResizeHandle({
  environmentId,
  initialHeight,
  onDraggingChange,
  onResize,
}: {
  environmentId: string;
  initialHeight: number;
  onDraggingChange: (dragging: boolean) => void;
  onResize: (environmentId: string, value: number) => void;
}) {
  const startRef = useRef<{ y: number; height: number } | null>(null);

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    startRef.current = null;
    onDraggingChange(false);
  }

  return (
    <div
      className="studio-main__resize-handle"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        startRef.current = {
          y: event.clientY,
          height: initialHeight,
        };
        onDraggingChange(true);
      }}
      onPointerMove={(event) => {
        if (!startRef.current) return;
        const delta = event.clientY - startRef.current.y;
        onResize(environmentId, startRef.current.height - delta);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
