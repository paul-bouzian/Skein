import { normalizeBrowserUrl } from "./browser-preview";
import type {
  BrowserPanelBounds,
  BrowserTabEventName,
} from "./desktop-types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const BROWSER_TAB_EVENT_NAMES: readonly BrowserTabEventName[] = [
  "did-start-loading",
  "did-stop-loading",
  "did-navigate",
  "did-fail-load",
  "page-title-updated",
  "page-favicon-updated",
  "open-window-request",
];

const BROWSER_TAB_EVENT_SET = new Set<string>(BROWSER_TAB_EVENT_NAMES);

export function assertBrowserTabId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Browser tabId must be a UUID v4 string.");
  }
  return value;
}

export function assertBrowserEnvId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("Browser envId must be a non-empty string.");
  }
  return value;
}

export function assertBrowserUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Browser URL must be a string.");
  }
  if (value === "about:blank") {
    return value;
  }
  const normalized = normalizeBrowserUrl(value);
  if (!normalized) {
    throw new Error("Browser URL must be a valid http(s) URL.");
  }
  return normalized;
}

export function assertPanelBounds(value: unknown): BrowserPanelBounds | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Panel bounds must be an object or null.");
  }
  const { x, y, width, height } = value as Record<string, unknown>;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    throw new Error("Panel bounds must have numeric x/y/width/height.");
  }
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 0 ||
    height < 0
  ) {
    throw new Error("Panel bounds dimensions must be finite and non-negative.");
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function assertBrowserTabEventName(value: string): BrowserTabEventName {
  if (!BROWSER_TAB_EVENT_SET.has(value)) {
    throw new Error(`Unsupported browser tab event: ${value}`);
  }
  return value as BrowserTabEventName;
}
