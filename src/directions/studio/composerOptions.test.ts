import { describe, expect, it } from "vitest";

import type { ModelOption } from "../../lib/types";
import {
  composerModelOptions,
  MODEL_FALLBACK_OPTIONS,
  settingsModelOptions,
} from "./composerOptions";
import { formatModelLabel, labelForModelOption } from "./modelLabels";

const MODEL_OPTION: ModelOption = {
  id: "gpt-5.3-codex",
  displayName: "GPT-5.3-Codex",
  description: "Fallback Codex model",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high"],
  inputModalities: ["text"],
  supportedServiceTiers: [],
  isDefault: false,
};

describe("composerOptions", () => {
  it("formats runtime model display names for pickers", () => {
    expect(composerModelOptions([MODEL_OPTION])).toEqual([
      {
        value: "gpt-5.3-codex",
        label: "GPT-5.3 Codex",
      },
    ]);
  });

  it("formats fallback and selected model ids consistently", () => {
    expect(MODEL_FALLBACK_OPTIONS.find((option) => option.value === "gpt-5.3-codex"))
      .toEqual({
        value: "gpt-5.3-codex",
        label: "GPT-5.3 Codex",
      });
    expect(settingsModelOptions([], "gpt-5.4-mini")[0]).toEqual({
      value: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
    });
  });
});

describe("modelLabels", () => {
  it("normalizes raw model ids into friendly labels", () => {
    expect(formatModelLabel("gpt-5.4-mini")).toBe("GPT-5.4 Mini");
    expect(formatModelLabel("codex-mini-latest")).toBe("Codex Mini Latest");
  });

  it("prefers model display names while preserving a fallback label", () => {
    expect(labelForModelOption(MODEL_OPTION)).toBe("GPT-5.3 Codex");
    expect(labelForModelOption(null)).toBe("the selected model");
  });
});
