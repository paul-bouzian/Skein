import { useEffect, useMemo, useState } from "react";

import { getShortcutDefaults } from "../../lib/bridge";
import {
  buildShortcutValue,
  formatShortcut,
  shortcutSignature,
} from "../../lib/shortcuts";
import type { ShortcutSettings, ShortcutSettingsPatch } from "../../lib/types";
import {
  SHORTCUT_DEFINITIONS,
  type ShortcutAction,
} from "./shortcutDefinitions";

type Props = {
  shortcuts: ShortcutSettings;
  disabled: boolean;
  onChange: (patch: ShortcutSettingsPatch) => void;
};

export function ShortcutsSettingsTab({ shortcuts, disabled, onChange }: Props) {
  const [search, setSearch] = useState("");
  const [capturingAction, setCapturingAction] = useState<ShortcutAction | null>(null);
  const [defaults, setDefaults] = useState<ShortcutSettings | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ShortcutAction, string>>>({});

  useEffect(() => {
    let cancelled = false;
    void getShortcutDefaults()
      .then((nextDefaults) => {
        if (!cancelled) {
          setDefaults(nextDefaults);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDefaults(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredGroups = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const definitions = normalizedSearch
      ? SHORTCUT_DEFINITIONS.filter((definition) => {
          const haystack = [
            definition.group,
            definition.label,
            definition.description,
            shortcuts[definition.action] ?? "",
            defaults?.[definition.action] ?? "",
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(normalizedSearch);
        })
      : SHORTCUT_DEFINITIONS;

    return ["General", "Navigation", "Composer"].map((group) => ({
      group,
      items: definitions.filter((definition) => definition.group === group),
    }));
  }, [defaults, search, shortcuts]);

  function saveShortcut(action: ShortcutAction, value: string | null) {
    const conflict = findShortcutConflict(shortcuts, action, value);
    if (conflict) {
      setErrors((current) => ({
        ...current,
        [action]: `${SHORTCUT_DEFINITIONS.find((definition) => definition.action === conflict)?.label ?? conflict} already uses this shortcut.`,
      }));
      return;
    }

    setErrors((current) => ({ ...current, [action]: undefined }));
    onChange({ [action]: value });
    setCapturingAction(null);
  }

  return (
    <div className="settings-shortcuts">
      <div className="settings-field">
        <label className="settings-field__label" htmlFor="settings-shortcuts-search">
          Search shortcuts
        </label>
        <input
          id="settings-shortcuts-search"
          className="settings-field__input"
          placeholder="Search by action or shortcut"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="settings-shortcuts__list">
        {filteredGroups.map(({ group, items }) =>
          items.length > 0 ? (
            <section key={group} className="settings-shortcuts__group">
              <div className="settings-shortcuts__group-header">
                <h3 className="settings-shortcuts__group-title">{group}</h3>
              </div>
              <div className="settings-shortcuts__items">
                {items.map((definition) => {
                  const currentValue = shortcuts[definition.action] ?? null;
                  const defaultValue = defaults?.[definition.action] ?? null;
                  const isCapturing = capturingAction === definition.action;
                  return (
                    <div
                      key={definition.action}
                      className="settings-shortcuts__item"
                    >
                      <div className="settings-shortcuts__copy">
                        <label className="settings-field__label">
                          {definition.label}
                        </label>
                        <p className="settings-field__help">
                          {definition.description}
                        </p>
                        <p className="settings-field__help">
                          Default: {formatShortcut(defaultValue)}
                        </p>
                        {errors[definition.action] ? (
                          <p className="settings-shortcuts__error">
                            {errors[definition.action]}
                          </p>
                        ) : null}
                        {isCapturing ? (
                          <p className="settings-field__help">
                            Press a shortcut. Backspace clears. Escape cancels.
                          </p>
                        ) : null}
                      </div>
                      <div className="settings-shortcuts__controls">
                        <input
                          className="settings-field__input settings-shortcuts__capture"
                          aria-label={`${definition.label} shortcut`}
                          readOnly
                          disabled={disabled}
                          placeholder="Type shortcut"
                          value={isCapturing ? "" : formatShortcut(currentValue)}
                          onFocus={() => {
                            setErrors((current) => ({
                              ...current,
                              [definition.action]: undefined,
                            }));
                            setCapturingAction(definition.action);
                          }}
                          onBlur={() => {
                            if (capturingAction === definition.action) {
                              setCapturingAction(null);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Tab" && !event.shiftKey) {
                              setCapturingAction(null);
                              return;
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              setCapturingAction(null);
                              return;
                            }
                            if (
                              event.key === "Backspace" ||
                              event.key === "Delete"
                            ) {
                              event.preventDefault();
                              saveShortcut(definition.action, null);
                              return;
                            }
                            const nextValue = buildShortcutValue(event.nativeEvent);
                            if (!nextValue) {
                              return;
                            }
                            event.preventDefault();
                            saveShortcut(definition.action, nextValue);
                          }}
                        />
                        <div className="settings-shortcuts__buttons">
                          <button
                            type="button"
                            className="tx-action-btn tx-action-btn--secondary"
                            disabled={disabled || currentValue == null}
                            onClick={() => saveShortcut(definition.action, null)}
                          >
                            Clear
                          </button>
                          <button
                            type="button"
                            className="tx-action-btn tx-action-btn--secondary"
                            disabled={
                              disabled ||
                              defaultValue == null ||
                              currentValue === defaultValue
                            }
                            onClick={() =>
                              saveShortcut(definition.action, defaultValue)
                            }
                          >
                            Reset
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null,
        )}
      </div>
    </div>
  );
}

function findShortcutConflict(
  shortcuts: ShortcutSettings,
  targetAction: ShortcutAction,
  nextValue: string | null,
) {
  const nextSignature = shortcutSignature(nextValue);
  if (!nextSignature) {
    return null;
  }

  for (const definition of SHORTCUT_DEFINITIONS) {
    if (definition.action === targetAction) {
      continue;
    }
    if (shortcutSignature(shortcuts[definition.action] ?? null) === nextSignature) {
      return definition.action;
    }
  }
  return null;
}
