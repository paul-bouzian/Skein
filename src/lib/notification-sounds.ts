import type { NotificationSoundId } from "./types";

import chordUrl from "../assets/notification-sounds/chord.wav";
import glassUrl from "../assets/notification-sounds/glass.wav";
import politeUrl from "../assets/notification-sounds/polite.wav";

export type NotificationSoundOption = {
  id: NotificationSoundId;
  label: string;
  url: string;
};

type NotificationSoundPlaybackChannel = "preview" | "alert";

export const NOTIFICATION_SOUND_OPTIONS: readonly NotificationSoundOption[] = [
  {
    id: "glass",
    label: "Glass",
    url: glassUrl,
  },
  {
    id: "chord",
    label: "Chord",
    url: chordUrl,
  },
  {
    id: "polite",
    label: "Polite",
    url: politeUrl,
  },
];

const activeAudioByChannel: Partial<
  Record<NotificationSoundPlaybackChannel, HTMLAudioElement>
> = {};

export function getNotificationSoundOption(
  soundId: NotificationSoundId,
): NotificationSoundOption {
  return (
    NOTIFICATION_SOUND_OPTIONS.find((option) => option.id === soundId) ??
    NOTIFICATION_SOUND_OPTIONS[0]
  );
}

function stopNotificationSoundPlayback(
  channel: NotificationSoundPlaybackChannel,
) {
  const audio = activeAudioByChannel[channel];
  if (!audio) {
    return;
  }

  delete activeAudioByChannel[channel];
  audio.pause();
  audio.currentTime = 0;
  audio.onended = null;
  audio.onerror = null;
}

async function playNotificationSoundForChannel(
  soundId: NotificationSoundId,
  channel: NotificationSoundPlaybackChannel,
): Promise<void> {
  if (typeof Audio === "undefined") {
    return;
  }

  stopNotificationSoundPlayback(channel);

  const audio = new Audio(getNotificationSoundOption(soundId).url);
  activeAudioByChannel[channel] = audio;
  audio.preload = "auto";

  const cleanup = () => {
    if (activeAudioByChannel[channel] === audio) {
      delete activeAudioByChannel[channel];
    }
    audio.onended = null;
    audio.onerror = null;
  };

  audio.onended = cleanup;
  audio.onerror = cleanup;

  try {
    await audio.play();
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function stopNotificationPreviewSound() {
  stopNotificationSoundPlayback("preview");
}

export async function playNotificationPreviewSound(
  soundId: NotificationSoundId,
): Promise<void> {
  await playNotificationSoundForChannel(soundId, "preview");
}

export async function playNotificationAlertSound(
  soundId: NotificationSoundId,
): Promise<void> {
  await playNotificationSoundForChannel(soundId, "alert");
}
