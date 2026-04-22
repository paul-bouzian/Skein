import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { formatShortcut } from "../../lib/shortcuts";
import { dialog } from "../../lib/shell";
import type { ProjectManualAction } from "../../lib/types";
import { CheckIcon, ChevronRightIcon, PlusIcon } from "../../shared/Icons";
import { useTerminalStore } from "../../stores/terminal-store";
import { ProjectActionIcon } from "./ProjectActionIcon";
import {
  preferredActionIdForProject,
  setPreferredActionIdForProject,
} from "./projectActions";
import "./EnvironmentActionControl.css";

type Props = {
  environmentId: string | null;
  projectId: string | null;
  actions: ProjectManualAction[];
  onAddAction: () => void;
};

type MenuPosition = {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
};

export function EnvironmentActionControl({
  environmentId,
  projectId,
  actions,
  onAddAction,
}: Props) {
  const openActionTab = useTerminalStore((state) => state.openActionTab);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const preferredActionId = useMemo(
    () =>
      projectId && actions.length > 0
        ? preferredActionIdForProject(projectId, actions)
        : null,
    [actions, projectId],
  );
  const activeAction = useMemo(
    () => actions.find((action) => action.id === preferredActionId) ?? actions[0] ?? null,
    [actions, preferredActionId],
  );

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const margin = 12;
    const gap = 8;

    function updateMenuPosition() {
      const root = rootRef.current;
      if (!root) {
        return;
      }

      const rect = root.getBoundingClientRect();
      const availableBelow = window.innerHeight - rect.bottom - margin - gap;
      const availableAbove = rect.top - margin - gap;
      const openUpward = availableBelow < 220 && availableAbove > availableBelow;
      const width = Math.min(280, Math.max(rect.width, 220));
      const left = Math.max(
        margin,
        Math.min(rect.right - width, window.innerWidth - width - margin),
      );
      const maxHeight = Math.max(
        160,
        Math.min(openUpward ? availableAbove : availableBelow, 320),
      );

      setMenuPosition(
        openUpward
          ? {
              left,
              bottom: window.innerHeight - rect.top + gap,
              width,
              maxHeight,
            }
          : {
              left,
              top: rect.bottom + gap,
              width,
              maxHeight,
            },
      );
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setMenuOpen(false);
    }

    updateMenuPosition();
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  if (!environmentId || !projectId) {
    return null;
  }

  const hasActions = actions.length > 0;
  const disabled = busy;

  function openAddActionDialog() {
    setMenuOpen(false);
    onAddAction();
  }

  async function launchAction(action: ProjectManualAction) {
    if (!environmentId || !projectId || busy) {
      return;
    }

    setBusy(true);
    setMenuOpen(false);
    try {
      const tabId = await openActionTab(environmentId, action);
      if (!tabId) {
        await dialog.message("Maximum 10 terminals are open in this environment.", {
          title: "Project action",
          kind: "warning",
        });
        return;
      }
      setPreferredActionIdForProject(projectId, action.id);
    } catch (cause: unknown) {
      await dialog.message(
        cause instanceof Error ? cause.message : "Failed to run project action.",
        {
          title: "Project action",
          kind: "error",
        },
      );
    } finally {
      setBusy(false);
    }
  }

  function handlePrimaryActionClick() {
    if (activeAction) {
      void launchAction(activeAction);
      return;
    }

    openAddActionDialog();
  }

  return (
    <>
      <div
        ref={rootRef}
        className={`environment-action-control ${menuOpen ? "environment-action-control--open" : ""}`}
      >
        <button
          type="button"
          className="environment-action-control__main"
          disabled={disabled}
          title={activeAction ? `Run ${activeAction.label}` : "Add project action"}
          aria-label={activeAction ? `Run ${activeAction.label}` : "Add project action"}
          onClick={handlePrimaryActionClick}
        >
          {activeAction ? (
            <ProjectActionIcon
              icon={activeAction.icon}
              size={14}
              className="environment-action-control__icon"
            />
          ) : (
            <PlusIcon size={14} className="environment-action-control__icon" />
          )}
          <span className="environment-action-control__label">
            {activeAction?.label ?? "Add action"}
          </span>
        </button>
        <button
          type="button"
          className="environment-action-control__chevron"
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={hasActions ? "Choose project action" : "Project action options"}
          title={hasActions ? "Choose project action" : "Project action options"}
          onClick={() => setMenuOpen((current) => !current)}
        >
          <ChevronRightIcon
            size={10}
            className={`environment-action-control__chevron-icon ${
              menuOpen ? "environment-action-control__chevron-icon--open" : ""
            }`}
          />
        </button>
      </div>
      {menuOpen && menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label="Project actions"
              className="environment-action-control__menu tx-dropdown-menu"
              style={{ ...menuPosition, zIndex: 1200 }}
            >
              {actions.map((action) => {
                const isPrimary = action.id === activeAction?.id;
                return (
                  <button
                    key={action.id}
                    type="button"
                    role="menuitem"
                    className={`environment-action-control__option tx-dropdown-option ${
                      isPrimary ? "environment-action-control__option--selected" : ""
                    }`}
                    onClick={() => void launchAction(action)}
                  >
                    <ProjectActionIcon
                      icon={action.icon}
                      size={16}
                      className="environment-action-control__option-icon"
                    />
                    <span className="environment-action-control__option-copy">
                      <span className="environment-action-control__option-label">
                        {action.label}
                      </span>
                      <span className="environment-action-control__option-meta">
                        {formatShortcut(action.shortcut ?? null)}
                      </span>
                    </span>
                    {isPrimary ? (
                      <span className="environment-action-control__option-check" aria-hidden="true">
                        <CheckIcon size={12} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {hasActions ? (
                <div className="environment-action-control__divider" role="separator" />
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="environment-action-control__option environment-action-control__option--add tx-dropdown-option"
                onClick={openAddActionDialog}
              >
                <PlusIcon
                  size={16}
                  className="environment-action-control__option-icon environment-action-control__option-icon--add"
                />
                <span className="environment-action-control__option-copy">
                  <span className="environment-action-control__option-label">Add action</span>
                  <span className="environment-action-control__option-meta">
                    Create a reusable project action
                  </span>
                </span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
