import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as notificationSounds from "../../lib/notification-sounds";

import { makeGlobalSettings } from "../../test/fixtures/conversation";
import { NotificationsSettingsTab } from "./NotificationsSettingsTab";

vi.mock("../../lib/notification-sounds", () => {
  const options = [
    { id: "glass", label: "Glass", url: "/glass.wav" },
    { id: "chord", label: "Chord", url: "/chord.wav" },
    { id: "polite", label: "Polite", url: "/polite.wav" },
  ] as const;

  return {
    NOTIFICATION_SOUND_OPTIONS: options,
    getNotificationSoundOption: (soundId: (typeof options)[number]["id"]) =>
      options.find((option) => option.id === soundId) ?? options[0],
    playNotificationPreviewSound: vi.fn(() => Promise.resolve()),
    stopNotificationPreviewSound: vi.fn(),
  };
});

const mockedNotificationSounds = vi.mocked(notificationSounds);

describe("NotificationsSettingsTab", () => {
  beforeEach(() => {
    mockedNotificationSounds.playNotificationPreviewSound.mockReset();
    mockedNotificationSounds.stopNotificationPreviewSound.mockReset();
  });

  it("renders the desktop toggle and both sound sections", () => {
    render(
      <NotificationsSettingsTab
        settings={makeGlobalSettings()}
        disabled={false}
        desktopNotificationsBusy={false}
        desktopNotificationsNotice={null}
        menuZIndex={1310}
        onChange={() => undefined}
        onDesktopNotificationsChange={async () => undefined}
      />,
    );

    expect(screen.getByRole("switch", { name: "Desktop notifications" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Needs attention" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Work completed" })).toBeInTheDocument();
    expect(screen.getByText("Needs attention sound")).toBeInTheDocument();
    expect(screen.getByText("Work completed sound")).toBeInTheDocument();
  });

  it("saves a new sound choice for the attention channel", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <NotificationsSettingsTab
        settings={makeGlobalSettings()}
        disabled={false}
        desktopNotificationsBusy={false}
        desktopNotificationsNotice={null}
        menuZIndex={1310}
        onChange={onChange}
        onDesktopNotificationsChange={async () => undefined}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Needs attention sound picker" }),
    );
    await user.click(screen.getByRole("button", { name: "Chord" }));

    expect(onChange).toHaveBeenCalledWith({
      notificationSounds: {
        attention: {
          sound: "chord",
        },
      },
    });
  });

  it("previews sounds from the current selection and the picker menu, then stops playback on unmount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <NotificationsSettingsTab
        settings={makeGlobalSettings()}
        disabled={false}
        desktopNotificationsBusy={false}
        desktopNotificationsNotice={null}
        menuZIndex={1310}
        onChange={() => undefined}
        onDesktopNotificationsChange={async () => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Preview Glass sound" }));
    expect(mockedNotificationSounds.playNotificationPreviewSound).toHaveBeenCalledWith(
      "glass",
    );

    await user.click(
      screen.getByRole("button", { name: "Needs attention sound picker" }),
    );
    const optionGroup = screen.getByRole("group", {
      name: "Needs attention sound options",
    });
    await user.click(
      within(optionGroup).getByRole("button", { name: "Preview Chord sound" }),
    );

    expect(
      mockedNotificationSounds.playNotificationPreviewSound,
    ).toHaveBeenLastCalledWith("chord");

    unmount();

    expect(mockedNotificationSounds.stopNotificationPreviewSound).toHaveBeenCalledTimes(
      1,
    );
  });

  it("keeps the selected sound visible when the channel is turned off", async () => {
    const user = userEvent.setup();
    const settings = makeGlobalSettings({
      notificationSounds: {
        attention: {
          enabled: true,
          sound: "chord",
        },
        completion: {
          enabled: false,
          sound: "polite",
        },
      },
    });
    const onChange = vi.fn();

    render(
      <NotificationsSettingsTab
        settings={settings}
        disabled={false}
        desktopNotificationsBusy={false}
        desktopNotificationsNotice={null}
        menuZIndex={1310}
        onChange={onChange}
        onDesktopNotificationsChange={async () => undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Needs attention sound picker" }),
    ).toHaveTextContent("Chord");

    await user.click(screen.getByRole("switch", { name: "Needs attention" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        notificationSounds: {
          attention: {
            enabled: false,
          },
        },
      });
    });
    expect(
      screen.getByRole("button", { name: "Needs attention sound picker" }),
    ).toHaveTextContent("Chord");
  });
});
