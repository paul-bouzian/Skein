import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeGlobalSettings } from "../../test/fixtures/conversation";
import { BehaviorSettingsTab } from "./BehaviorSettingsTab";

describe("BehaviorSettingsTab", () => {
  it("renders multi-agent controls and disables the slider when the mode is off", () => {
    render(
      <BehaviorSettingsTab
        disabled={false}
        settings={makeGlobalSettings()}
        onChange={() => undefined}
      />,
    );

    expect(screen.getByRole("switch", { name: "Multi-agent mode" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Max subagents" })).toBeDisabled();
  });

  it("keeps the slider interactive while settings are saving", () => {
    render(
      <BehaviorSettingsTab
        disabled={true}
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
      <BehaviorSettingsTab
        disabled={false}
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
      <BehaviorSettingsTab
        disabled={false}
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

  it("does not save the slider twice when pointer and mouse release both fire", () => {
    const onChange = vi.fn();

    render(
      <BehaviorSettingsTab
        disabled={false}
        settings={makeGlobalSettings({ multiAgentNudgeEnabled: true })}
        onChange={onChange}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Max subagents" });
    fireEvent.change(slider, {
      target: { value: "6" },
    });

    fireEvent.pointerUp(slider);
    fireEvent.mouseUp(slider);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ multiAgentNudgeMaxSubagents: 6 });
  });
});
