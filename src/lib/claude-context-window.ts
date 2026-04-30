const CLAUDE_ONE_MILLION_SUFFIX = "[1m]";
const CLAUDE_DEFAULT_CONTEXT_TOKENS = 200_000;
const CLAUDE_ONE_MILLION_CONTEXT_TOKENS = 1_000_000;

export function claudeBaseModelId(modelId: string): string {
  return modelId.endsWith(CLAUDE_ONE_MILLION_SUFFIX)
    ? modelId.slice(0, -CLAUDE_ONE_MILLION_SUFFIX.length)
    : modelId;
}

export function claudeUsesOneMillionContext(modelId: string): boolean {
  return modelId.endsWith(CLAUDE_ONE_MILLION_SUFFIX);
}

export function claudeOneMillionModelId(modelId: string): string {
  return `${claudeBaseModelId(modelId)}${CLAUDE_ONE_MILLION_SUFFIX}`;
}

export function claudeContextWindowForModel(modelId: string): number {
  return claudeUsesOneMillionContext(modelId)
    ? CLAUDE_ONE_MILLION_CONTEXT_TOKENS
    : CLAUDE_DEFAULT_CONTEXT_TOKENS;
}
