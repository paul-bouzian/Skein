import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import * as bridge from "../../lib/bridge";
import type {
  ApprovalPolicy,
  CollaborationMode,
  GlobalSettings,
  GlobalSettingsPatch,
  ReasoningEffort,
} from "../../lib/types";
import {
  selectConversationCapabilities,
  useConversationStore,
} from "../../stores/conversation-store";
import {
  selectSettings,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { CloseIcon } from "../../shared/Icons";
import { ComposerPicker, type ComposerPickerOption } from "./ComposerPicker";
import {
  APPROVAL_OPTIONS,
  COLLABORATION_OPTIONS,
  REASONING_OPTIONS,
  settingsModelOptions,
} from "./composerOptions";
import "./SettingsDialog.css";

type Props = {
  open: boolean;
  onClose: () => void;
};

const SETTINGS_PICKER_Z_INDEX = 1310;
const SETTINGS_REFRESH_ERROR =
  "Settings were saved, but the workspace snapshot could not be refreshed.";

export function SettingsDialog({ open, onClose }: Props) {
  const settings = useWorkspaceStore(selectSettings);
  const selectedEnvironmentId = useWorkspaceStore(
    (state) => state.selectedEnvironmentId,
  );
  const capabilities = useConversationStore(
    selectConversationCapabilities(selectedEnvironmentId),
  );
  const refreshSnapshot = useWorkspaceStore((state) => state.refreshSnapshot);
  const [actionError, setActionError] = useState<string | null>(null);
  const modelOptions = useMemo(
    () =>
      settings
        ? settingsModelOptions(capabilities?.models ?? [], settings.defaultModel)
        : [],
    [capabilities?.models, settings],
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      queueMicrotask(() => {
        if (event.defaultPrevented) {
          return;
        }

        event.preventDefault();
        onClose();
      });
    }

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setActionError(null);
    }
  }, [open]);

  async function handleChange(patch: GlobalSettingsPatch) {
    try {
      setActionError(null);
      await bridge.updateGlobalSettings(patch);
      const refreshed = await refreshSnapshot();
      if (!refreshed) {
        throw new Error(SETTINGS_REFRESH_ERROR);
      }
    } catch (cause: unknown) {
      setActionError(
        cause instanceof Error ? cause.message : "Failed to save settings",
      );
    }
  }

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="settings-dialog__backdrop" onClick={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-dialog__header">
          <h2 id="settings-dialog-title" className="settings-dialog__title">
            Settings
          </h2>
          <button
            type="button"
            className="settings-dialog__close"
            onClick={onClose}
            aria-label="Close settings"
            title="Close settings"
          >
            <CloseIcon size={12} />
          </button>
        </div>

        <div className="settings-dialog__layout">
          <div
            className="settings-dialog__sidebar"
            role="navigation"
            aria-label="Settings sections"
          >
            <div
              className="settings-dialog__tab settings-dialog__tab--active"
              aria-current="page"
            >
              Codex
            </div>
          </div>
          <div className="settings-dialog__body">
            {actionError ? (
              <p className="settings-dialog__notice">{actionError}</p>
            ) : null}
            {settings ? (
              <SettingsContent
                settings={settings}
                modelOptions={modelOptions}
                onChange={handleChange}
              />
            ) : (
              <p className="settings-dialog__empty">Loading...</p>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function SettingsContent({
  settings,
  modelOptions,
  onChange,
}: {
  settings: GlobalSettings;
  modelOptions: ComposerPickerOption[];
  onChange: (patch: GlobalSettingsPatch) => void;
}) {
  return (
    <div className="settings-list">
      <SettingsSelect
        label="Default model"
        value={settings.defaultModel}
        options={modelOptions}
        onChange={(value) => onChange({ defaultModel: value })}
      />
      <SettingsSelect
        label="Default reasoning"
        value={settings.defaultReasoningEffort}
        options={REASONING_OPTIONS}
        onChange={(value) =>
          onChange({ defaultReasoningEffort: value as ReasoningEffort })
        }
      />
      <SettingsSelect
        label="Default mode"
        value={settings.defaultCollaborationMode}
        options={COLLABORATION_OPTIONS}
        onChange={(value) =>
          onChange({ defaultCollaborationMode: value as CollaborationMode })
        }
      />
      <SettingsSelect
        label="Default approval"
        value={settings.defaultApprovalPolicy}
        options={APPROVAL_OPTIONS}
        onChange={(value) =>
          onChange({ defaultApprovalPolicy: value as ApprovalPolicy })
        }
      />
      <SettingsInput
        label="Codex binary"
        value={settings.codexBinaryPath ?? ""}
        placeholder="auto-detect"
        onChange={(value) => onChange({ codexBinaryPath: value || null })}
      />
    </div>
  );
}

function SettingsSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ComposerPickerOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <ComposerPicker
      label={label}
      value={value}
      options={options}
      menuZIndex={SETTINGS_PICKER_Z_INDEX}
      onChange={(nextValue) => onChange(nextValue as T)}
    />
  );
}

function SettingsInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <div className="settings-field">
      <label className="settings-field__label">{label}</label>
      <input
        className="settings-field__input"
        type="text"
        value={draftValue}
        placeholder={placeholder}
        onChange={(event) => setDraftValue(event.target.value)}
        onBlur={(event) => {
          const nextValue = event.target.value;
          if (nextValue !== value) {
            onChange(nextValue);
          }
        }}
      />
    </div>
  );
}
