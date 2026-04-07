export type FileReferenceTarget = {
  rawTarget: string;
  filePath: string;
  line: number | null;
  column: number | null;
};

const HASH_POSITION_PATTERN = /#L(\d+)(?:C(\d+))?$/;
const COLON_POSITION_PATTERN = /:(\d+)(?::(\d+))?$/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const ROOT_LEVEL_FILE_PATTERN =
  /^(?:\.[A-Za-z0-9._-]+|[A-Za-z0-9_-][A-Za-z0-9() _-]*\.[A-Za-z0-9._-]+)$/;

export function parseFileReferenceTarget(target: string): FileReferenceTarget | null {
  const rawTarget = target.trim();
  if (!rawTarget) {
    return null;
  }

  let filePath = rawTarget;
  let line: number | null = null;
  let column: number | null = null;

  const hashPosition = rawTarget.match(HASH_POSITION_PATTERN);
  if (hashPosition?.index !== undefined) {
    filePath = rawTarget.slice(0, hashPosition.index);
    line = parsePositiveInteger(hashPosition[1]);
    column = parsePositiveInteger(hashPosition[2]);
  } else {
    const colonPosition = rawTarget.match(COLON_POSITION_PATTERN);
    if (colonPosition?.index !== undefined) {
      const candidatePath = rawTarget.slice(0, colonPosition.index);
      if (isLikelyLocalFilePath(candidatePath)) {
        filePath = candidatePath;
        line = parsePositiveInteger(colonPosition[1]);
        column = parsePositiveInteger(colonPosition[2]);
      }
    }
  }

  const normalizedPath = filePath.trim();
  if (!isLikelyLocalFilePath(normalizedPath)) {
    return null;
  }

  return {
    rawTarget,
    filePath: normalizedPath,
    line,
    column,
  };
}

function isLikelyLocalFilePath(value: string) {
  if (!value || value.startsWith("//")) {
    return false;
  }

  if (isWindowsAbsolutePath(value)) {
    return true;
  }

  if (hasUriScheme(value)) {
    return false;
  }

  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    isLikelyRelativeFilePath(value)
  );
}

function hasUriScheme(value: string) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function isWindowsAbsolutePath(value: string) {
  return WINDOWS_ABSOLUTE_PATH_PATTERN.test(value);
}

function isLikelyRelativeFilePath(value: string) {
  const normalized = value.trim();
  if (ROOT_LEVEL_FILE_PATTERN.test(normalized)) {
    return true;
  }

  const segments = normalized.split(/[\\/]/).filter(Boolean);
  const tail = segments[segments.length - 1] ?? "";
  return segments.length > 1 && ROOT_LEVEL_FILE_PATTERN.test(tail);
}

function parsePositiveInteger(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
