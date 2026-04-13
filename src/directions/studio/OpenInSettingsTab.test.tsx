import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeGlobalSettings } from "../../test/fixtures/conversation";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { OpenInSettingsTab } from "./OpenInSettingsTab";

type UpdateGlobalSettingsResult = {
  ok: boolean;
  refreshed: boolean;
  warningMessage: string | null;
  errorMessage: string | null;
  settings: ReturnType<typeof makeGlobalSettings> | null;
};

describe("OpenInSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    useWorkspaceStore.setState({
      updateGlobalSettings: vi.fn(async () => ({
        ok: true,
        refreshed: true,
        warningMessage: null,
        errorMessage: null,
        settings: makeGlobalSettings(),
      })),
    });
  });

  it("keeps Save disabled during an in-flight save when equivalent props refresh", async () => {
    const user = userEvent.setup();
    const settings = makeGlobalSettings();
    let resolveSave!: (value: UpdateGlobalSettingsResult) => void;
    const updateGlobalSettings = vi.fn(
      () =>
        new Promise<UpdateGlobalSettingsResult>((resolve) => {
          resolveSave = resolve;
        }),
    );
    useWorkspaceStore.setState({ updateGlobalSettings });

    const { rerender } = render(
      <OpenInSettingsTab
        targets={settings.openTargets}
        defaultTargetId={settings.defaultOpenTargetId}
      />,
    );

    // Click "Set as default" on the second target to trigger dirty state
    const defaultButtons = screen.getAllByRole("button", { name: /Set .* as default/i });
    await user.click(defaultButtons[0]!);
    await user.click(screen.getByRole("button", { name: "Save" }));

    rerender(
      <OpenInSettingsTab
        targets={settings.openTargets.map((target) => ({ ...target }))}
        defaultTargetId={settings.defaultOpenTargetId}
      />,
    );

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    resolveSave({
      ok: true,
      refreshed: true,
      warningMessage: null,
      errorMessage: null,
      settings: makeGlobalSettings(),
    });

    await waitFor(() => {
      expect(updateGlobalSettings).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps default change local until Save is clicked", async () => {
    const user = userEvent.setup();
    const updateGlobalSettings = vi.fn(async () => ({
      ok: true,
      refreshed: true,
      warningMessage: null,
      errorMessage: null,
      settings: makeGlobalSettings(),
    }));
    useWorkspaceStore.setState({ updateGlobalSettings });

    render(
      <OpenInSettingsTab
        targets={makeGlobalSettings().openTargets}
        defaultTargetId={makeGlobalSettings().defaultOpenTargetId}
      />,
    );

    // Change the default target
    const defaultButtons = screen.getAllByRole("button", { name: /Set .* as default/i });
    await user.click(defaultButtons[0]!);

    expect(updateGlobalSettings).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateGlobalSettings).toHaveBeenCalledTimes(1);
    });
  });

  it("saves a changed default target", async () => {
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
      <OpenInSettingsTab
        targets={makeGlobalSettings().openTargets}
        defaultTargetId={makeGlobalSettings().defaultOpenTargetId}
      />,
    );

    // Click "Set as default" on a non-default target
    const defaultButtons = screen.getAllByRole("button", { name: /Set .* as default/i });
    await user.click(defaultButtons[0]!);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateGlobalSettings).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps in-progress state when props refresh with equivalent values", async () => {
    const user = userEvent.setup();
    const settings = makeGlobalSettings();
    const { rerender } = render(
      <OpenInSettingsTab
        targets={settings.openTargets}
        defaultTargetId={settings.defaultOpenTargetId}
      />,
    );

    // Change the default to make the form dirty
    const defaultButtons = screen.getAllByRole("button", { name: /Set .* as default/i });
    await user.click(defaultButtons[0]!);

    rerender(
      <OpenInSettingsTab
        targets={settings.openTargets.map((target) => ({ ...target }))}
        defaultTargetId={settings.defaultOpenTargetId}
      />,
    );

    // Save button should be enabled (dirty state preserved)
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});
