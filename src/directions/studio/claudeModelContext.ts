import type { ModelOption, ProviderKind } from "../../lib/types";
import {
  claudeBaseModelId,
  claudeContextWindowForModel,
  claudeOneMillionModelId,
  claudeUsesOneMillionContext,
} from "../../lib/claude-context-window";

export {
  claudeBaseModelId,
  claudeOneMillionModelId,
  claudeUsesOneMillionContext,
};

export function claudeModelSupportsOneMillionContext(
  modelId: string,
  models: ModelOption[],
): boolean {
  const oneMillionId = claudeOneMillionModelId(modelId);
  return models.some(
    (model) =>
      (model.provider ?? "codex") === "claude" && model.id === oneMillionId,
  );
}

export function claudeModelContextTokens(
  provider: ProviderKind,
  modelId: string,
): number | null {
  if (provider !== "claude") return null;
  return claudeContextWindowForModel(modelId);
}

export function stripClaudeContextSuffix(label: string): string {
  return label.replace(/\s+1M$/i, "");
}

export function stripClaudeModelLabelPrefix(label: string): string {
  return label.replace(/^Claude\s+/i, "");
}

export function claudeModelPickerLabel(label: string): string {
  return stripClaudeModelLabelPrefix(stripClaudeContextSuffix(label));
}

export function resolveClaudeModelForContext(
  modelId: string,
  useOneMillionContext: boolean,
  models: ModelOption[],
): string {
  const baseModelId = claudeBaseModelId(modelId);
  const targetModelId = useOneMillionContext
    ? claudeOneMillionModelId(baseModelId)
    : baseModelId;
  const targetExists = models.some(
    (model) =>
      (model.provider ?? "codex") === "claude" && model.id === targetModelId,
  );
  if (targetExists) return targetModelId;
  const baseExists = models.some(
    (model) =>
      (model.provider ?? "codex") === "claude" && model.id === baseModelId,
  );
  return baseExists ? baseModelId : modelId;
}

export function resolveClaudeModelForSelection(
  selectedModelId: string,
  currentModelId: string,
  models: ModelOption[],
): string {
  return resolveClaudeModelForContext(
    selectedModelId,
    claudeUsesOneMillionContext(currentModelId),
    models,
  );
}
