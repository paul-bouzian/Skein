import { beforeEach, describe, expect, it, vi } from "vitest";

class MockAudio {
  static instances: MockAudio[] = [];

  currentTime = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(() => Promise.resolve());
  preload = "";

  constructor(readonly src: string) {
    MockAudio.instances.push(this);
  }
}

describe("notification sounds", () => {
  beforeEach(() => {
    vi.resetModules();
    MockAudio.instances = [];
    globalThis.Audio = MockAudio as unknown as typeof Audio;
  });

  it("stopping preview playback does not stop an active alert sound", async () => {
    const sounds = await import("./notification-sounds");

    await sounds.playNotificationAlertSound("glass");
    await sounds.playNotificationPreviewSound("chord");

    const [alertAudio, previewAudio] = MockAudio.instances;
    expect(alertAudio).toBeDefined();
    expect(previewAudio).toBeDefined();

    sounds.stopNotificationPreviewSound();

    expect(previewAudio.pause).toHaveBeenCalledTimes(1);
    expect(previewAudio.currentTime).toBe(0);
    expect(alertAudio.pause).not.toHaveBeenCalled();
  });
});
