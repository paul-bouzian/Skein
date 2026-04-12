import { message } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import * as bridge from "../../lib/bridge";
import type { GlobalSettings, OpenTarget } from "../../lib/types";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { CheckIcon, ChevronRightIcon } from "../../shared/Icons";
import { OpenTargetIcon } from "./OpenTargetIcon";
import "./OpenEnvironmentControl.css";

type Props = {
  environmentId: string | null;
  settings: GlobalSettings | null;
};

type MenuPosition = {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
};

const EMPTY_TARGETS: OpenTarget[] = [];

export function OpenEnvironmentControl({ environmentId, settings }: Props) {
  const updateGlobalSettings = useWorkspaceStore((state) => state.updateGlobalSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const targets = settings?.openTargets ?? EMPTY_TARGETS;
  const activeTargetId = pendingTargetId ?? settings?.defaultOpenTargetId ?? null;
  const activeTarget = useMemo(
    () => resolveOpenTarget(targets, activeTargetId),
    [activeTargetId, targets],
  );

  useEffect(() => {
    if (pendingTargetId && pendingTargetId === settings?.defaultOpenTargetId) {
      setPendingTargetId(null);
    }
  }, [pendingTargetId, settings?.defaultOpenTargetId]);

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
      const width = Math.min(260, Math.max(rect.width, 208));
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

  const disabled = !environmentId || !activeTarget || busy;
  const mainTitle = environmentId
    ? activeTarget
      ? `Open environment in ${activeTarget.label}`
      : "Open environment"
    : "Select an environment to open it externally";

  async function openTarget(target: OpenTarget, persistDefault: boolean) {
    if (!environmentId || busy) {
      return;
    }

    const shouldPersist = persistDefault && target.id !== settings?.defaultOpenTargetId;
    setBusy(true);
    setMenuOpen(false);
    if (shouldPersist) {
      setPendingTargetId(target.id);
    }

    try {
      await bridge.openEnvironment({ environmentId, targetId: target.id });
      if (shouldPersist) {
        const result = await updateGlobalSettings({
          defaultOpenTargetId: target.id,
        });
        if (!result.ok) {
          throw new Error(result.errorMessage ?? "Failed to save Open In target");
        }
        if (result.warningMessage) {
          await message(result.warningMessage, {
            title: "Open In",
            kind: "warning",
          });
        }
      }
    } catch (cause: unknown) {
      if (shouldPersist) {
        setPendingTargetId(null);
      }
      await message(
        cause instanceof Error ? cause.message : "Failed to open environment",
        {
          title: "Open In",
          kind: "error",
        },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div
        ref={rootRef}
        className={`open-environment-control ${menuOpen ? "open-environment-control--open" : ""}`}
      >
        <button
          type="button"
          className="open-environment-control__main"
          disabled={disabled}
          title={mainTitle}
          aria-label={activeTarget ? `Open environment in ${activeTarget.label}` : "Open environment"}
          onClick={() => activeTarget && void openTarget(activeTarget, false)}
        >
          {activeTarget ? (
            <OpenTargetIcon
              target={activeTarget}
              size={14}
              className="open-environment-control__icon"
            />
          ) : null}
          <span className="open-environment-control__label">
            {activeTarget?.label ?? "Open"}
          </span>
        </button>
        <button
          type="button"
          className="open-environment-control__chevron"
          disabled={targets.length === 0 || busy || !environmentId}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Choose open target"
          title="Choose open target"
          onClick={() => setMenuOpen((current) => !current)}
        >
          <ChevronRightIcon
            size={10}
            className={`open-environment-control__chevron-icon ${
              menuOpen ? "open-environment-control__chevron-icon--open" : ""
            }`}
          />
        </button>
      </div>
      {menuOpen && menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label="Open target options"
              className="open-environment-control__menu tx-dropdown-menu"
              style={{ ...menuPosition, zIndex: 1200 }}
            >
              {targets.map((target) => {
                const isSelected = target.id === (settings?.defaultOpenTargetId ?? "");
                return (
                  <button
                    key={target.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    className={`open-environment-control__option tx-dropdown-option ${
                      isSelected ? "open-environment-control__option--selected" : ""
                    }`}
                    onClick={() => void openTarget(target, true)}
                  >
                    <OpenTargetIcon
                      target={target}
                      size={16}
                      className="open-environment-control__option-icon"
                    />
                    <span className="open-environment-control__option-copy">
                      <span className="open-environment-control__option-label">
                        {target.label}
                      </span>
                      <span className="open-environment-control__option-meta">
                        {labelForTargetKind(target)}
                      </span>
                    </span>
                    {isSelected ? (
                      <span className="open-environment-control__option-check" aria-hidden="true">
                        <CheckIcon size={12} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function resolveOpenTarget(targets: OpenTarget[], targetId: string | null) {
  if (targets.length === 0) {
    return null;
  }
  if (!targetId) {
    return targets[0] ?? null;
  }
  return targets.find((target) => target.id === targetId) ?? targets[0] ?? null;
}

function labelForTargetKind(target: OpenTarget) {
  switch (target.kind) {
    case "app":
      return target.appName ?? "Application";
    case "fileManager":
      return "System file manager";
  }
}
