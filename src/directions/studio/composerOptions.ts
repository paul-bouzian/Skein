import type {
  ApprovalPolicy,
  CollaborationMode,
  ModelOption,
  ReasoningEffort,
} from "../../lib/types";
import type { ComposerPickerOption } from "./ComposerPicker";

const MODEL_FALLBACK_IDS = [
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5",
  "o4-mini",
  "o3",
  "codex-mini-latest",
] as const;

export const MODEL_FALLBACK_OPTIONS: ComposerPickerOption[] =
  MODEL_FALLBACK_IDS.map((modelId) => ({
    value: modelId,
    label: modelId,
  }));

export const REASONING_OPTIONS: ComposerPickerOption<ReasoningEffort>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

export const COLLABORATION_OPTIONS: ComposerPickerOption<CollaborationMode>[] = [
  { value: "build", label: "Build" },
  { value: "plan", label: "Plan" },
];

export const APPROVAL_OPTIONS: ComposerPickerOption<ApprovalPolicy>[] = [
  { value: "askToEdit", label: "Ask to edit" },
  { value: "fullAccess", label: "Full access" },
];

export function composerModelOptions(
  models: ModelOption[],
  selectedValue?: string,
): ComposerPickerOption[] {
  return ensureSelectedOption(
    models.map((model) => ({
      value: model.id,
      label: model.id,
    })),
    selectedValue,
  );
}

export function settingsModelOptions(
  models: ModelOption[],
  selectedValue: string,
): ComposerPickerOption[] {
  return ensureSelectedOption(
    models.length > 0 ? composerModelOptions(models) : MODEL_FALLBACK_OPTIONS,
    selectedValue,
  );
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
      label: selectedValue,
    },
    ...options,
  ];
}
