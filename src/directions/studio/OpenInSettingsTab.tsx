import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import type { OpenTarget } from "../../lib/types";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { CheckIcon, GripVerticalIcon } from "../../shared/Icons";
import { OpenTargetIcon } from "./OpenTargetIcon";
import { SettingsSection } from "./SettingsSection";
import {
  buildDraftState,
  matchesPersistedTargets,
  persistedOpenInSettingsEqual,
  persistDraftTargets,
  validateDraftTargets,
  type OpenInDraftState,
} from "./openInSettingsDraft";

type Props = {
  targets: OpenTarget[];
  defaultTargetId: string;
};

export function OpenInSettingsTab({ targets, defaultTargetId }: Props) {
  const updateGlobalSettings = useWorkspaceStore((state) => state.updateGlobalSettings);
  const [draftState, setDraftState] = useState<OpenInDraftState>(() =>
    buildDraftState(targets, defaultTargetId),
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const lastPersistedTargetsRef = useRef(targets);
  const lastDefaultTargetIdRef = useRef(defaultTargetId);

  const [dragState, setDragState] = useState<{
    active: boolean;
    originIndex: number;
    currentIndex: number;
    offsetY: number;
  } | null>(null);
  const dragStartY = useRef(0);
  const dragOriginIndex = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (
      persistedOpenInSettingsEqual(
        lastPersistedTargetsRef.current,
        lastDefaultTargetIdRef.current,
        targets,
        defaultTargetId,
      )
    ) {
      return;
    }

    lastPersistedTargetsRef.current = targets;
    lastDefaultTargetIdRef.current = defaultTargetId;
    setDraftState(buildDraftState(targets, defaultTargetId));
    setSaving(false);
  }, [defaultTargetId, targets]);

  const issues = useMemo(
    () => validateDraftTargets(draftState.targets, draftState.defaultDraftKey),
    [draftState.defaultDraftKey, draftState.targets],
  );
  const dirty = useMemo(
    () =>
      !matchesPersistedTargets(
        draftState.targets,
        draftState.defaultDraftKey,
        targets,
        defaultTargetId,
      ),
    [defaultTargetId, draftState.defaultDraftKey, draftState.targets, targets],
  );
  const noticeMessage = saveError ?? issues.global;

  async function handleSave() {
    if (issues.global) {
      setSaveError(issues.global);
      return;
    }

    const persistedDraftState = persistDraftTargets(draftState);
    if (!persistedDraftState) {
      setSaveError("Choose a default target before saving.");
      return;
    }

    setSaving(true);
    setSaveError(null);
    const result = await updateGlobalSettings(persistedDraftState);
    setSaving(false);

    if (!result.ok) {
      setSaveError(result.errorMessage ?? "Failed to save Open In settings.");
      return;
    }
    if (result.warningMessage) {
      setSaveError(result.warningMessage);
    }
  }

  function handleReset() {
    setDraftState(buildDraftState(targets, defaultTargetId));
    setSaveError(null);
  }

  function updateDraftState(
    updater: (current: OpenInDraftState) => OpenInDraftState,
  ) {
    setSaveError(null);
    setDraftState((current) => updater(current));
  }

  function handleDragStart(e: PointerEvent, index: number) {
    if (saving) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragStartY.current = e.clientY;
    dragOriginIndex.current = index;
    setDragState({ active: true, originIndex: index, currentIndex: index, offsetY: 0 });
  }

  function handleDragMove(e: PointerEvent) {
    if (!dragState) return;
    const itemHeight = itemRefs.current[0]?.getBoundingClientRect().height ?? 64;
    const gap = 8;
    const delta = e.clientY - dragStartY.current;
    const indexOffset = Math.round(delta / (itemHeight + gap));
    const newIndex = Math.max(
      0,
      Math.min(draftState.targets.length - 1, dragOriginIndex.current + indexOffset),
    );
    setDragState((prev) =>
      prev ? { ...prev, currentIndex: newIndex, offsetY: delta } : null,
    );
  }

  function handleDragEnd() {
    if (dragState && dragState.originIndex !== dragState.currentIndex) {
      const fromIndex = dragState.originIndex;
      const toIndex = dragState.currentIndex;
      updateDraftState((current) => {
        const next = [...current.targets];
        const [moved] = next.splice(fromIndex, 1);
        if (moved) {
          next.splice(toIndex, 0, moved);
        }
        return { ...current, targets: next };
      });
    }
    setDragState(null);
  }

  function handleGripKeyDown(e: React.KeyboardEvent, index: number) {
    if (saving) return;
    if (e.key === "ArrowUp" && index > 0) {
      e.preventDefault();
      updateDraftState((current) => {
        const next = [...current.targets];
        const [moved] = next.splice(index, 1);
        if (moved) {
          next.splice(index - 1, 0, moved);
        }
        return { ...current, targets: next };
      });
    } else if (e.key === "ArrowDown" && index < draftState.targets.length - 1) {
      e.preventDefault();
      updateDraftState((current) => {
        const next = [...current.targets];
        const [moved] = next.splice(index, 1);
        if (moved) {
          next.splice(index + 1, 0, moved);
        }
        return { ...current, targets: next };
      });
    }
  }

  function getDragStyle(index: number): React.CSSProperties | undefined {
    if (!dragState) return undefined;
    const itemHeight = itemRefs.current[0]?.getBoundingClientRect().height ?? 64;
    const gap = 8;
    const step = itemHeight + gap;

    if (index === dragState.originIndex) {
      return {
        transform: `translateY(${dragState.offsetY}px)`,
        zIndex: 10,
        position: "relative",
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.3)",
        transition: "box-shadow 120ms ease",
      };
    }

    const { originIndex, currentIndex } = dragState;
    if (originIndex < currentIndex && index > originIndex && index <= currentIndex) {
      return { transform: `translateY(${-step}px)`, transition: "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)" };
    }
    if (originIndex > currentIndex && index < originIndex && index >= currentIndex) {
      return { transform: `translateY(${step}px)`, transition: "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)" };
    }

    return { transform: "translateY(0)", transition: "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)" };
  }

  return (
    <SettingsSection
      title="Targets"
      description="Drag to reorder. Click the checkmark to set as default. Appears in the Open In menu on right-click."
    >
      {noticeMessage ? (
        <p className="settings-notice">{noticeMessage}</p>
      ) : null}
      <div
        ref={listRef}
        className="settings-open-targets__list"
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
      >
        {draftState.targets.map(({ draftKey, target }, index) => {
          const isDefault = draftKey === draftState.defaultDraftKey;
          const isDragging = dragState?.originIndex === index;
          return (
            <div
              key={draftKey}
              ref={(el) => { itemRefs.current[index] = el; }}
              className={[
                "settings-open-target",
                isDefault ? "settings-open-target--default" : null,
                isDragging ? "settings-open-target--dragging" : null,
              ]
                .filter(Boolean)
                .join(" ")}
              style={getDragStyle(index)}
            >
              <span
                className="settings-open-target__grip"
                tabIndex={0}
                role="button"
                aria-label={`Reorder ${target.label}`}
                onPointerDown={(e) => handleDragStart(e, index)}
                onKeyDown={(e) => handleGripKeyDown(e, index)}
              >
                <GripVerticalIcon size={14} />
              </span>
              <span className="settings-open-target__preview" aria-hidden="true">
                <OpenTargetIcon
                  target={target}
                  size={20}
                  className="settings-open-target__preview-icon"
                />
              </span>
              <div className="settings-open-target__info">
                <span className="settings-open-target__label">{target.label}</span>
                <span className="settings-open-target__description">
                  {describeTarget(target)}
                </span>
              </div>
              <button
                type="button"
                className={[
                  "settings-open-target__default-btn",
                  isDefault ? "settings-open-target__default-btn--active" : null,
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={saving || isDefault}
                aria-label={isDefault ? "Default" : `Set ${target.label} as default`}
                title={isDefault ? "Default" : "Set as default"}
                onClick={() =>
                  updateDraftState((current) => ({
                    ...current,
                    defaultDraftKey: draftKey,
                  }))
                }
              >
                <CheckIcon size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="settings-open-targets__actions">
        <button
          type="button"
          className="tx-action-btn tx-action-btn--secondary"
          disabled={saving || !dirty}
          onClick={handleReset}
        >
          Reset
        </button>
        <button
          type="button"
          className="tx-action-btn tx-action-btn--primary"
          disabled={saving || !dirty || issues.global != null}
          onClick={() => void handleSave()}
        >
          Save
        </button>
      </div>
    </SettingsSection>
  );
}

function describeTarget(target: OpenTarget) {
  if (target.kind === "fileManager") {
    return "System file manager";
  }

  return target.appName ?? "Application";
}
