import type {
  ApprovalPolicy,
  CollaborationMode,
  DefaultDraftEnvironment,
  ModelOption,
  ProviderKind,
  ReasoningEffort,
  ServiceTier,
} from "../../lib/types";
import { formatModelLabel, labelForModelOption } from "./modelLabels";
import type { ComposerPickerOption } from "./ComposerPicker";
import {
  claudeBaseModelId,
  claudeModelPickerLabel,
  stripClaudeModelLabelPrefix,
} from "./claudeModelContext";

const MODEL_ORDER_IDS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.2",
] as const;

const MODEL_FALLBACK_IDS = MODEL_ORDER_IDS;

const CLAUDE_MODEL_FALLBACK_IDS = [
  "claude-opus-4-7",
  "claude-opus-4-7[1m]",
  "claude-opus-4-6",
  "claude-opus-4-6[1m]",
  "claude-opus-4-5",
  "claude-opus-4-5[1m]",
  "claude-sonnet-4-6",
  "claude-sonnet-4-6[1m]",
  "claude-haiku-4-5",
] as const;

const MODEL_ORDER = new Map<string, number>(
  [...MODEL_ORDER_IDS, ...CLAUDE_MODEL_FALLBACK_IDS].map((modelId, index) => [
    modelId,
    index,
  ]),
);

const FALLBACK_MODEL_LABELS: Partial<Record<string, string>> = {
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-7[1m]": "Opus 4.7 1M",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-6[1m]": "Opus 4.6 1M",
  "claude-opus-4-5": "Opus 4.5",
  "claude-opus-4-5[1m]": "Opus 4.5 1M",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-sonnet-4-6[1m]": "Sonnet 4.6 1M",
  "claude-haiku-4-5": "Haiku 4.5",
};

export const MODEL_FALLBACK_OPTIONS: ComposerPickerOption[] =
  MODEL_FALLBACK_IDS.map((modelId) => ({
    value: modelId,
    label: fallbackModelLabel(modelId),
  }));

export const REASONING_OPTIONS: ComposerPickerOption<ReasoningEffort>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
];

export const PROVIDER_OPTIONS: ComposerPickerOption<ProviderKind>[] = [
  { value: "codex", label: "OpenAI" },
  { value: "claude", label: "Anthropic" },
];

export const COLLABORATION_OPTIONS: ComposerPickerOption<CollaborationMode>[] = [
  { value: "build", label: "Build" },
  { value: "plan", label: "Plan" },
];

export const APPROVAL_OPTIONS: ComposerPickerOption<ApprovalPolicy>[] = [
  { value: "askToEdit", label: "Ask to edit" },
  { value: "autoReview", label: "Auto review" },
  { value: "fullAccess", label: "Full access" },
];

export const SPEED_MODE_OPTIONS: ComposerPickerOption<ServiceTier>[] = [
  { value: "flex", label: "Normal" },
  { value: "fast", label: "Fast" },
];

export const DRAFT_ENVIRONMENT_OPTIONS: ComposerPickerOption<DefaultDraftEnvironment>[] = [
  { value: "local", label: "Local" },
  { value: "newWorktree", label: "New worktree" },
];

export function composerModelOptions(
  models: ModelOption[],
  selectedValue?: string,
  provider?: ProviderKind,
): ComposerPickerOption[] {
  const scopedModels = provider
    ? models.filter((model) => (model.provider ?? "codex") === provider)
    : models;
  if (provider === "claude") {
    return ensureSelectedOption(
      collapsedClaudeModelOptions(scopedModels, selectedValue),
      selectedValue,
    );
  }
  return ensureSelectedOption(
    sortModelOptionsByPreference(scopedModels).map((model) => ({
      value: model.id,
      label: labelForModelOption(model, model.id),
    })),
    selectedValue,
  );
}

function collapsedClaudeModelOptions(
  models: ModelOption[],
  selectedValue?: string,
): ComposerPickerOption[] {
  const seen = new Set<string>();
  return sortModelOptionsByPreference(models).flatMap((model) => {
    const baseModelId = claudeBaseModelId(model.id);
    if (seen.has(baseModelId)) {
      return [];
    }
    seen.add(baseModelId);
    const selectedSameBase =
      selectedValue && claudeBaseModelId(selectedValue) === baseModelId;
    return [
      {
        value: selectedSameBase ? selectedValue : baseModelId,
        label: claudeModelPickerLabel(labelForModelOption(model, model.id)),
      },
    ];
  });
}

export function sortModelOptionsByPreference<T extends Pick<ModelOption, "id" | "displayName">>(
  models: T[],
): T[] {
  return [...models].sort(compareModelOptionsByPreference);
}

function compareModelOptionsByPreference<T extends Pick<ModelOption, "id" | "displayName">>(
  left: T,
  right: T,
) {
  const leftOrder = MODEL_ORDER.get(left.id) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = MODEL_ORDER.get(right.id) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return labelForModelOption(left, left.id).localeCompare(
    labelForModelOption(right, right.id),
  );
}

export function settingsModelOptions(
  models: ModelOption[],
  selectedValue: string,
  provider: ProviderKind = "codex",
): ComposerPickerOption[] {
  const fallback =
    provider === "claude"
      ? CLAUDE_MODEL_FALLBACK_IDS.map((modelId) => ({
          value: modelId,
          label: fallbackModelLabel(modelId),
        }))
      : MODEL_FALLBACK_OPTIONS;
  return ensureSelectedOption(
    models.length > 0 ? settingsScopedModelOptions(models, provider) : fallback,
    selectedValue,
  );
}

function settingsScopedModelOptions(
  models: ModelOption[],
  provider: ProviderKind,
): ComposerPickerOption[] {
  return sortModelOptionsByPreference(
    models.filter((model) => (model.provider ?? "codex") === provider),
  ).map((model) => ({
    value: model.id,
    label: settingsModelLabel(model, provider),
  }));
}

function settingsModelLabel(
  model: ModelOption,
  provider: ProviderKind,
): string {
  const label = labelForModelOption(model, model.id);
  return provider === "claude" ? stripClaudeModelLabelPrefix(label) : label;
}

export function reasoningOptionsFor(
  efforts: ReasoningEffort[],
): ComposerPickerOption<ReasoningEffort>[] {
  const supportedEfforts = new Set(efforts);
  return REASONING_OPTIONS.filter((option) =>
    supportedEfforts.has(option.value),
  );
}

export function labelForCollaborationMode(
  value: string,
  fallback = value,
): string {
  if (fallback !== value) {
    return fallback;
  }

  return (
    COLLABORATION_OPTIONS.find((option) => option.value === value)?.label ??
    value
  );
}

function ensureSelectedOption<T extends string>(
  options: ComposerPickerOption<T>[],
  selectedValue?: string,
): ComposerPickerOption<T>[] {
  if (
    !selectedValue ||
    options.some((option) => option.value === selectedValue)
  ) {
    return options;
  }

  return [
    {
      value: selectedValue as T,
      label: fallbackModelLabel(selectedValue),
    },
    ...options,
  ];
}

function fallbackModelLabel(modelId: string): string {
  const label = FALLBACK_MODEL_LABELS[modelId] ?? formatModelLabel(modelId);
  return modelId.startsWith("claude-")
    ? stripClaudeModelLabelPrefix(label)
    : label;
}
