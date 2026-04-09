import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import { isMacPlatform } from "../../lib/shortcuts";
import { makeGlobalSettings } from "../../test/fixtures/conversation";
import { ShortcutsSettingsTab } from "./ShortcutsSettingsTab";

vi.mock("../../lib/bridge", () => ({
  getShortcutDefaults: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);

function primaryModifier() {
  return isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
}

describe("ShortcutsSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedBridge.getShortcutDefaults.mockResolvedValue(makeGlobalSettings().shortcuts);
  });

  it("captures and saves a shortcut binding", async () => {
    const onChange = vi.fn();

    render(
      <ShortcutsSettingsTab
        shortcuts={makeGlobalSettings().shortcuts}
        disabled={false}
        onChange={onChange}
      />,
    );

    const input = screen.getByLabelText("Toggle terminal shortcut");
    await userEvent.click(input);
    fireEvent.keyDown(input, {
      key: "k",
      ...primaryModifier(),
    });

    expect(onChange).toHaveBeenCalledWith({ toggleTerminal: "mod+k" });
  });

  it("captures Shift+Tab for the mode-cycling shortcut", async () => {
    const onChange = vi.fn();

    render(
      <ShortcutsSettingsTab
        shortcuts={makeGlobalSettings().shortcuts}
        disabled={false}
        onChange={onChange}
      />,
    );

    const input = screen.getByLabelText("Cycle Build/Plan mode shortcut");
    await userEvent.click(input);
    fireEvent.keyDown(input, {
      key: "Tab",
      shiftKey: true,
    });

    expect(onChange).toHaveBeenCalledWith({
      cycleCollaborationMode: "shift+tab",
    });
  });

  it("blocks duplicate shortcuts and surfaces an inline error", async () => {
    const onChange = vi.fn();

    render(
      <ShortcutsSettingsTab
        shortcuts={makeGlobalSettings().shortcuts}
        disabled={false}
        onChange={onChange}
      />,
    );

    const input = screen.getByLabelText("Toggle terminal shortcut");
    await userEvent.click(input);
    fireEvent.keyDown(input, {
      key: "g",
      ...primaryModifier(),
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText("Toggle Review panel already uses this shortcut."),
    ).toBeInTheDocument();
  });

  it("resets a shortcut back to its default binding", async () => {
    const onChange = vi.fn();
    const shortcuts = {
      ...makeGlobalSettings().shortcuts,
      toggleTerminal: "mod+k",
    };

    render(
      <ShortcutsSettingsTab
        shortcuts={shortcuts}
        disabled={false}
        onChange={onChange}
      />,
    );

    await waitFor(() => {
      expect(mockedBridge.getShortcutDefaults).toHaveBeenCalledTimes(1);
    });

    const input = screen.getByLabelText("Toggle terminal shortcut");
    const item = input.closest(".settings-shortcuts__item");
    expect(item).not.toBeNull();
    const resetButton = within(item as HTMLElement).getByRole("button", { name: "Reset" });

    await waitFor(() => {
      expect(resetButton).toBeEnabled();
    });

    await userEvent.click(resetButton);

    expect(onChange).toHaveBeenCalledWith({ toggleTerminal: "mod+j" });
  });
});
