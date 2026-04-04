import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { CheckIcon, ChevronRightIcon } from "../../shared/Icons";
import "./ComposerPicker.css";

export type ComposerPickerOption<T extends string = string> = {
  label: string;
  value: T;
};

type Props = {
  label: string;
  value: string;
  options: ComposerPickerOption[];
  disabled?: boolean;
  menuZIndex?: number;
  tone?: "default" | "accent";
  onChange: (value: string) => void;
};

type MenuPosition = {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

export function ComposerPicker({
  label,
  value,
  options,
  disabled = false,
  menuZIndex = 30,
  tone = "default",
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const isAccent = tone === "accent";

  const selected = useMemo(() => {
    return options.find((option) => option.value === value) ?? null;
  }, [options, value]);

  useEffect(() => {
    if (!open) return;

    const margin = 12;
    const gap = 8;

    function updateMenuPosition() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const availableBelow = window.innerHeight - rect.bottom - margin - gap;
      const availableAbove = rect.top - margin - gap;
      const openUpward =
        availableBelow < 180 && availableAbove > availableBelow;
      const maxHeight = Math.max(
        140,
        Math.min(openUpward ? availableAbove : availableBelow, 280),
      );
      const width = Math.min(rect.width, window.innerWidth - margin * 2);
      const left = Math.max(
        margin,
        Math.min(rect.left, window.innerWidth - width - margin),
      );

      setMenuPosition(
        openUpward
          ? {
              left,
              width,
              maxHeight,
              bottom: window.innerHeight - rect.top + gap,
            }
          : {
              left,
              width,
              maxHeight,
              top: rect.bottom + gap,
            },
      );
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        rootRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }

      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      event.preventDefault();
      setOpen(false);
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
  }, [open]);

  return (
    <div ref={rootRef} className={`tx-picker ${open ? "tx-picker--open" : ""}`}>
      <span className="tx-picker__label">{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className={`tx-picker__trigger ${isAccent ? "tx-picker__trigger--accent" : ""}`}
        disabled={disabled}
        aria-expanded={open}
        aria-label={`${label} picker`}
        onClick={() => setOpen((current) => !current)}
      >
        <span
          className={`tx-picker__value ${isAccent ? "tx-picker__value--accent" : ""}`}
        >
          {selected?.label ?? value}
        </span>
        <ChevronRightIcon
          size={12}
          className={`tx-picker__chevron ${open ? "tx-picker__chevron--open" : ""}`}
        />
      </button>
      {open && menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              className="tx-picker__menu"
              role="listbox"
              aria-label={`${label} options`}
              style={{ ...menuPosition, zIndex: menuZIndex }}
            >
              {options.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`tx-picker__option ${isSelected ? "tx-picker__option--selected" : ""}`}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span>{option.label}</span>
                    {isSelected ? (
                      <span
                        className="tx-picker__option-check"
                        aria-hidden="true"
                      >
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
    </div>
  );
}
