import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  getNotificationSoundOption,
  NOTIFICATION_SOUND_OPTIONS,
  playNotificationPreviewSound,
  stopNotificationPreviewSound,
} from "../../lib/notification-sounds";
import type {
  GlobalSettings,
  GlobalSettingsPatch,
  NotificationSoundChannelSettings,
  NotificationSoundChannelSettingsPatch,
  NotificationSoundId,
} from "../../lib/types";
import { CheckIcon, ChevronRightIcon, SpeakerIcon } from "../../shared/Icons";
import { SettingsSwitch, SettingsToggle } from "./SettingsControls";

type Props = {
  settings: Pick<
    GlobalSettings,
    "desktopNotificationsEnabled" | "notificationSounds"
  >;
  disabled: boolean;
  desktopNotificationsBusy: boolean;
  desktopNotificationsNotice: string | null;
  menuZIndex: number;
  onChange: (patch: GlobalSettingsPatch) => Promise<void> | void;
  onDesktopNotificationsChange: (enabled: boolean) => Promise<void>;
};

type MenuPosition = {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

export function NotificationsSettingsTab({
  settings,
  disabled,
  desktopNotificationsBusy,
  desktopNotificationsNotice,
  menuZIndex,
  onChange,
  onDesktopNotificationsChange,
}: Props) {
  const attentionSettings = settings.notificationSounds.attention;
  const completionSettings = settings.notificationSounds.completion;

  useEffect(() => {
    return () => {
      stopNotificationPreviewSound();
    };
  }, []);

  function previewSound(soundId: NotificationSoundId) {
    void playNotificationPreviewSound(soundId).catch(() => {
      // Ignore preview failures; the sound settings remain usable without them.
    });
  }

  function updateNotificationSoundChannel(
    channel: "attention" | "completion",
    patch: NotificationSoundChannelSettingsPatch,
  ) {
    void onChange({
      notificationSounds:
        channel === "attention" ? { attention: patch } : { completion: patch },
    });
  }

  return (
    <div className="settings-list">
      <SettingsToggle
        disabled={disabled || desktopNotificationsBusy}
        label="Desktop notifications"
        description="Show an OS notification when a chat finishes or needs input while the app is in the background."
        supportText="Desktop app notifications use your operating system notification center."
        notice={desktopNotificationsNotice}
        noticeTone="error"
        checked={settings.desktopNotificationsEnabled}
        onChange={(value) => void onDesktopNotificationsChange(value)}
      />
      <NotificationSoundSection
        label="Needs attention"
        description="Play a sound when Codex needs your approval, needs answers to a requestUserInput prompt, or is waiting on a plan decision."
        supportText="This sound plays for background activity and also when another thread needs you while you are focused elsewhere in Skein."
        disabled={disabled}
        menuZIndex={menuZIndex}
        value={attentionSettings}
        onPreview={previewSound}
        onToggle={(enabled) =>
          updateNotificationSoundChannel("attention", { enabled })
        }
        onSoundChange={(sound) =>
          updateNotificationSoundChannel("attention", { sound })
        }
      />
      <NotificationSoundSection
        label="Work completed"
        description="Play a sound when a thread finishes and Codex returns a final answer."
        supportText="Use a calmer sound here if you want completion cues to feel less urgent than attention alerts."
        disabled={disabled}
        menuZIndex={menuZIndex}
        value={completionSettings}
        onPreview={previewSound}
        onToggle={(enabled) =>
          updateNotificationSoundChannel("completion", { enabled })
        }
        onSoundChange={(sound) =>
          updateNotificationSoundChannel("completion", { sound })
        }
      />
    </div>
  );
}

function NotificationSoundSection({
  label,
  description,
  supportText,
  disabled,
  menuZIndex,
  value,
  onToggle,
  onSoundChange,
  onPreview,
}: {
  label: string;
  description: string;
  supportText: string;
  disabled: boolean;
  menuZIndex: number;
  value: NotificationSoundChannelSettings;
  onToggle: (enabled: boolean) => void;
  onSoundChange: (sound: NotificationSoundId) => void;
  onPreview: (sound: NotificationSoundId) => void;
}) {
  return (
    <section className="settings-sound">
      <div className="settings-sound__header">
        <div className="settings-toggle__copy">
          <label className="settings-field__label">{label}</label>
          <p className="settings-field__help">{description}</p>
          <p className="settings-field__help">{supportText}</p>
        </div>
        <SettingsSwitch
          label={label}
          disabled={disabled}
          checked={value.enabled}
          onChange={onToggle}
        />
      </div>
      <div className="settings-sound__body">
        <NotificationSoundPicker
          disabled={disabled}
          label={`${label} sound`}
          menuZIndex={menuZIndex}
          value={value.sound}
          onChange={onSoundChange}
          onPreview={onPreview}
        />
      </div>
    </section>
  );
}

function NotificationSoundPicker({
  disabled,
  label,
  menuZIndex,
  value,
  onChange,
  onPreview,
}: {
  disabled: boolean;
  label: string;
  menuZIndex: number;
  value: NotificationSoundId;
  onChange: (sound: NotificationSoundId) => void;
  onPreview: (sound: NotificationSoundId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const popupId = useId();
  const selected = useMemo(() => getNotificationSoundOption(value), [value]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const margin = 12;
    const gap = 8;

    function updateMenuPosition() {
      const trigger = triggerRef.current;
      if (!trigger) {
        return;
      }

      const rect = trigger.getBoundingClientRect();
      const availableBelow = window.innerHeight - rect.bottom - margin - gap;
      const availableAbove = rect.top - margin - gap;
      const openUpward =
        availableBelow < 220 && availableAbove > availableBelow;
      const maxHeight = Math.max(
        180,
        Math.min(openUpward ? availableAbove : availableBelow, 320),
      );
      const width = Math.min(Math.max(rect.width, 220), window.innerWidth - margin * 2);
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
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

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
    <div ref={rootRef} className="settings-sound-picker">
      <span className="settings-field__label">{label}</span>
      <div className="settings-sound-picker__row">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-controls={open ? popupId : undefined}
          aria-expanded={open}
          aria-label={`${label} picker`}
          className="settings-sound-picker__trigger"
          onClick={() => setOpen((current) => !current)}
        >
          <span className="settings-sound-picker__trigger-value">
            {selected.label}
          </span>
          <ChevronRightIcon
            size={12}
            className={`settings-sound-picker__chevron ${
              open ? "settings-sound-picker__chevron--open" : ""
            }`}
          />
        </button>
        <button
          type="button"
          disabled={disabled}
          className="settings-sound-picker__preview"
          aria-label={`Preview ${selected.label} sound`}
          onClick={() => onPreview(value)}
        >
          <SpeakerIcon size={14} />
        </button>
      </div>
      {open && menuPosition
        ? createPortal(
            <div
              id={popupId}
              ref={menuRef}
              role="group"
              aria-label={`${label} options`}
              className="settings-sound-picker__menu tx-dropdown-menu"
              style={{ ...menuPosition, zIndex: menuZIndex }}
            >
              {NOTIFICATION_SOUND_OPTIONS.map((option) => {
                const isSelected = option.id === value;
                return (
                  <div
                    key={option.id}
                    className="settings-sound-picker__option-row"
                  >
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      className={`settings-sound-picker__option tx-dropdown-option ${
                        isSelected ? "settings-sound-picker__option--selected" : ""
                      }`}
                      onClick={() => {
                        onChange(option.id);
                        setOpen(false);
                      }}
                    >
                      <span>{option.label}</span>
                      {isSelected ? (
                        <span
                          className="settings-sound-picker__option-check"
                          aria-hidden="true"
                        >
                          <CheckIcon size={12} />
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      className="settings-sound-picker__option-preview"
                      aria-label={`Preview ${option.label} sound`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onPreview(option.id);
                      }}
                    >
                      <SpeakerIcon size={14} />
                    </button>
                  </div>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
