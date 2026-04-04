import { useEffect, useState } from "react";
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
  selectSettings,
  useWorkspaceStore,
} from "../../stores/workspace-store";
import { CloseIcon } from "../../shared/Icons";
import { ComposerPicker, type ComposerPickerOption } from "./ComposerPicker";
import "./SettingsDialog.css";

type Props = {
  open: boolean;
  onClose: () => void;
};

const SETTINGS_PICKER_Z_INDEX = 1310;

const MODEL_OPTIONS: ComposerPickerOption[] = [
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  { value: "gpt-5", label: "gpt-5" },
  { value: "o4-mini", label: "o4-mini" },
  { value: "o3", label: "o3" },
  { value: "codex-mini-latest", label: "codex-mini-latest" },
];

const REASONING_OPTIONS: ComposerPickerOption<ReasoningEffort>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

const COLLABORATION_OPTIONS: ComposerPickerOption<CollaborationMode>[] = [
  { value: "build", label: "Build" },
  { value: "plan", label: "Plan" },
];

const APPROVAL_OPTIONS: ComposerPickerOption<ApprovalPolicy>[] = [
  { value: "askToEdit", label: "Ask to edit" },
  { value: "fullAccess", label: "Full access" },
];

export function SettingsDialog({ open, onClose }: Props) {
  const settings = useWorkspaceStore(selectSettings);
  const refreshSnapshot = useWorkspaceStore((state) => state.refreshSnapshot);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.key !== "Escape") return;

      event.preventDefault();
      onClose();
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
      await refreshSnapshot();
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
          <div className="settings-dialog__header-copy">
            <h2 id="settings-dialog-title" className="settings-dialog__title">
              Settings
            </h2>
            <p className="settings-dialog__subtitle">
              These defaults prefill the chat composer whenever you create a new
              thread.
            </p>
          </div>
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

        <div className="settings-dialog__body">
          {actionError ? (
            <p className="settings-dialog__notice">{actionError}</p>
          ) : null}
          {settings ? (
            <SettingsContent settings={settings} onChange={handleChange} />
          ) : (
            <p className="settings-dialog__empty">Loading...</p>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function SettingsContent({
  settings,
  onChange,
}: {
  settings: GlobalSettings;
  onChange: (patch: GlobalSettingsPatch) => void;
}) {
  return (
    <div className="settings-list">
      <SettingsSelect
        label="Default model"
        value={settings.defaultModel}
        options={MODEL_OPTIONS}
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
  return (
    <div className="settings-field">
      <label className="settings-field__label">{label}</label>
      <input
        className="settings-field__input"
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
