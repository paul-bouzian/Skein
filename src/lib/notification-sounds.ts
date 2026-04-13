import type { NotificationSoundId } from "./types";

import chordUrl from "../assets/notification-sounds/chord.wav";
import glassUrl from "../assets/notification-sounds/glass.wav";
import politeUrl from "../assets/notification-sounds/polite.wav";

export type NotificationSoundOption = {
  id: NotificationSoundId;
  label: string;
  url: string;
};

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

let activeAudio: HTMLAudioElement | null = null;

export function getNotificationSoundOption(
  soundId: NotificationSoundId,
): NotificationSoundOption {
  return (
    NOTIFICATION_SOUND_OPTIONS.find((option) => option.id === soundId) ??
    NOTIFICATION_SOUND_OPTIONS[0]
  );
}

export function stopNotificationSoundPlayback() {
  if (!activeAudio) {
    return;
  }

  const audio = activeAudio;
  activeAudio = null;
  audio.pause();
  audio.currentTime = 0;
  audio.onended = null;
  audio.onerror = null;
}

export async function playNotificationSound(
  soundId: NotificationSoundId,
): Promise<void> {
  if (typeof Audio === "undefined") {
    return;
  }

  stopNotificationSoundPlayback();

  const audio = new Audio(getNotificationSoundOption(soundId).url);
  activeAudio = audio;
  audio.preload = "auto";

  const cleanup = () => {
    if (activeAudio === audio) {
      activeAudio = null;
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
