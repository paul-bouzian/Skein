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
    expect(MODEL_FALLBACK_OPTIONS[0]).toEqual({
      value: "gpt-5.5",
      label: "GPT-5.5",
    });
    expect(MODEL_FALLBACK_OPTIONS.find((option) => option.value === "gpt-5.3-codex"))
      .toEqual({
        value: "gpt-5.3-codex",
        label: "GPT-5.3 Codex",
      });
    expect(settingsModelOptions([], "gpt-5.4-mini")).toContainEqual({
      value: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
    });
    expect(settingsModelOptions([], "claude-opus-4-7[1m]", "claude")).toContainEqual({
      value: "claude-opus-4-7[1m]",
      label: "Opus 4.7 1M",
    });
  });

  it("orders runtime models by the canonical newest-first list", () => {
    const olderModel: ModelOption = {
      ...MODEL_OPTION,
      id: "gpt-5.2",
      displayName: "GPT-5.2",
    };
    const newestModel: ModelOption = {
      ...MODEL_OPTION,
      id: "gpt-5.5",
      displayName: "GPT-5.5",
    };

    expect(composerModelOptions([olderModel, MODEL_OPTION, newestModel]))
      .toEqual([
        { value: "gpt-5.5", label: "GPT-5.5" },
        { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
        { value: "gpt-5.2", label: "GPT-5.2" },
      ]);
  });

  it("shows Claude 1M context as the selected model state, not a duplicate row", () => {
    const claudeBase: ModelOption = {
      ...MODEL_OPTION,
      provider: "claude",
      id: "claude-opus-4-7",
      displayName: "Claude Opus 4.7",
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    };
    const claudeLargeContext: ModelOption = {
      ...claudeBase,
      id: "claude-opus-4-7[1m]",
      displayName: "Claude Opus 4.7 1M",
    };

    expect(
      composerModelOptions(
        [claudeLargeContext, claudeBase],
        "claude-opus-4-7[1m]",
        "claude",
      ),
    ).toEqual([
      {
        value: "claude-opus-4-7[1m]",
        label: "Opus 4.7",
      },
    ]);
  });

  it("keeps Claude 1M models available in settings", () => {
    const claudeBase: ModelOption = {
      ...MODEL_OPTION,
      provider: "claude",
      id: "claude-opus-4-7",
      displayName: "Claude Opus 4.7",
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    };
    const claudeLargeContext: ModelOption = {
      ...claudeBase,
      id: "claude-opus-4-7[1m]",
      displayName: "Claude Opus 4.7 1M",
    };

    expect(
      settingsModelOptions(
        [claudeLargeContext, claudeBase],
        "claude-opus-4-7",
        "claude",
      ),
    ).toEqual([
      {
        value: "claude-opus-4-7",
        label: "Opus 4.7",
      },
      {
        value: "claude-opus-4-7[1m]",
        label: "Opus 4.7 1M",
      },
    ]);
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
