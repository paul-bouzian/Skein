import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeGlobalSettings } from "../../test/fixtures/conversation";
import { CodexSettingsTab } from "./CodexSettingsTab";

const MODEL_OPTIONS = [{ value: "gpt-5.4", label: "GPT-5.4" }] as const;

describe("CodexSettingsTab", () => {
  it("renders multi-agent controls and disables the slider when the mode is off", () => {
    render(
      <CodexSettingsTab
        disabled={false}
        menuZIndex={1310}
        modelOptions={[...MODEL_OPTIONS]}
        rangeDisabled={false}
        settings={makeGlobalSettings()}
        onChange={() => undefined}
      />,
    );

    expect(screen.getByRole("switch", { name: "Multi-agent mode" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Max subagents" })).toBeDisabled();
  });

  it("keeps the slider interactive while settings are saving", () => {
    render(
      <CodexSettingsTab
        disabled={true}
        menuZIndex={1310}
        modelOptions={[...MODEL_OPTIONS]}
        rangeDisabled={false}
        settings={makeGlobalSettings({ multiAgentNudgeEnabled: true })}
        onChange={() => undefined}
      />,
    );

    expect(screen.getByRole("slider", { name: "Max subagents" })).toBeEnabled();
  });

  it("saves the multi-agent toggle", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <CodexSettingsTab
        disabled={false}
        menuZIndex={1310}
        modelOptions={[...MODEL_OPTIONS]}
        rangeDisabled={false}
        settings={makeGlobalSettings()}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("switch", { name: "Multi-agent mode" }));

    expect(onChange).toHaveBeenCalledWith({ multiAgentNudgeEnabled: true });
  });

  it("saves the slider value when multi-agent mode is enabled", async () => {
    const onChange = vi.fn();

    render(
      <CodexSettingsTab
        disabled={false}
        menuZIndex={1310}
        modelOptions={[...MODEL_OPTIONS]}
        rangeDisabled={false}
        settings={makeGlobalSettings({ multiAgentNudgeEnabled: true })}
        onChange={onChange}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Max subagents" });
    fireEvent.change(slider, {
      target: { value: "6" },
    });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(slider);

    expect(onChange).toHaveBeenLastCalledWith({ multiAgentNudgeMaxSubagents: 6 });
  });
});
