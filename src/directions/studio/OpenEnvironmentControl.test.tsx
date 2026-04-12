import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import { makeGlobalSettings } from "../../test/fixtures/conversation";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { OpenEnvironmentControl } from "./OpenEnvironmentControl";
import { resetOpenAppIconCacheForTests } from "./useOpenAppIcons";

vi.mock("../../lib/bridge", () => ({
  openEnvironment: vi.fn(),
  getOpenAppIcon: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: vi.fn(),
}));

describe("OpenEnvironmentControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOpenAppIconCacheForTests();
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    vi.mocked(bridge.openEnvironment).mockResolvedValue(undefined);
    vi.mocked(bridge.getOpenAppIcon).mockResolvedValue(null);
    useWorkspaceStore.setState({
      updateGlobalSettings: vi.fn(async () => ({
        ok: true,
        refreshed: true,
        warningMessage: null,
        errorMessage: null,
        settings: makeGlobalSettings({ defaultOpenTargetId: "zed" }),
      })),
    });
  });

  it("opens the selected environment with the current default target", async () => {
    const user = userEvent.setup();

    render(
      <OpenEnvironmentControl
        environmentId="env-1"
        settings={makeGlobalSettings({ defaultOpenTargetId: "cursor" })}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Open environment in Cursor" }),
    );

    expect(bridge.openEnvironment).toHaveBeenCalledWith({
      environmentId: "env-1",
      targetId: "cursor",
    });
  });

  it("loads only the active app icon until the menu is opened", async () => {
    const user = userEvent.setup();

    render(
      <OpenEnvironmentControl
        environmentId="env-1"
        settings={makeGlobalSettings({ defaultOpenTargetId: "cursor" })}
      />,
    );

    await waitFor(() => {
      expect(bridge.getOpenAppIcon).toHaveBeenCalledTimes(1);
    });
    expect(bridge.getOpenAppIcon).toHaveBeenCalledWith("Cursor");

    await user.click(screen.getByRole("button", { name: "Choose open target" }));

    await waitFor(() => {
      expect(bridge.getOpenAppIcon).toHaveBeenCalledWith("Zed");
    });
    expect(bridge.getOpenAppIcon).toHaveBeenCalledTimes(2);
  });

  it("opens the chosen target from the menu and persists it as the new default", async () => {
    const user = userEvent.setup();
    const updateGlobalSettings = vi.fn(async () => ({
      ok: true,
      refreshed: true,
      warningMessage: null,
      errorMessage: null,
      settings: makeGlobalSettings({ defaultOpenTargetId: "zed" }),
    }));
    useWorkspaceStore.setState({ updateGlobalSettings });

    render(
      <OpenEnvironmentControl
        environmentId="env-1"
        settings={makeGlobalSettings()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose open target" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Zed/ }));

    expect(bridge.openEnvironment).toHaveBeenCalledWith({
      environmentId: "env-1",
      targetId: "zed",
    });
    await waitFor(() => {
      expect(updateGlobalSettings).toHaveBeenCalledWith({
        defaultOpenTargetId: "zed",
      });
    });
  });
});
