import type { ModelOption } from "../../lib/types";

type ModelLabelSource = Pick<ModelOption, "id" | "displayName">;

const TOKEN_LABELS: Record<string, string> = {
  codex: "Codex",
  gpt: "GPT",
  latest: "Latest",
  mini: "Mini",
};

function normalizeModelToken(token: string): string {
  const lower = token.toLowerCase();
  if (TOKEN_LABELS[lower]) {
    return TOKEN_LABELS[lower];
  }
  if (/^[a-z]\d/.test(lower)) {
    return lower;
  }
  if (/^\d/.test(token)) {
    return token;
  }
  if (token.toUpperCase() === token && /[A-Z]/.test(token)) {
    return token;
  }
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export function formatModelLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  const tokens = trimmed.split(/[\s_-]+/).filter(Boolean);
  if (tokens.length === 0) {
    return trimmed;
  }

  const parts: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const normalized = normalizeModelToken(token);
    const nextToken = tokens[index + 1];
    if (normalized === "GPT" && nextToken && /^\d/.test(nextToken)) {
      parts.push(`GPT-${nextToken}`);
      index += 1;
      continue;
    }
    parts.push(normalized);
  }
  return parts.join(" ");
}

export function labelForModelOption(
  model?: ModelLabelSource | null,
  fallback = "the selected model",
): string {
  const source = model?.displayName?.trim() || model?.id?.trim();
  return source ? formatModelLabel(source) : fallback;
}
