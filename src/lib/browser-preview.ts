// URL helpers for the integrated browser.
//
// `toPreviewUrl` / `fromPreviewUrl` translate between the user-facing
// http(s) URL the panel stores and the `skein-preview://` URL the iframe
// actually loads. The custom scheme is intercepted by the Electron preview
// protocol, which refetches the real URL and strips
// frame-blocking headers.
//
// `normalizeBrowserUrl` prepares raw text typed in the address bar:
// it accepts explicit http(s) URLs, auto-prefixes bare localhost with
// `http://`, auto-prefixes anything dotted with `https://`, and rejects
// unstructured input so the bar never doubles as a search box.

import {
  isLoopbackHost,
  parsePreviewTarget,
  toLoopbackPreviewUrl,
} from "./preview-url";

export { PREVIEW_SCHEME } from "./preview-url";
export { isLoopbackHost } from "./preview-url";

const LOOPBACK_PATTERN =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i;

// Converts the text typed in the address bar into a navigable URL, or
// returns `null` for values that don't parse as one. We auto-prefix bare
// loopback with `http://`, auto-prefix anything dotted with `https://`,
// then validate the result via `new URL()`.
export function normalizeBrowserUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidate = buildCandidate(trimmed);
  if (candidate === null) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

const DISALLOWED_SCHEMES = /^(file|javascript|data|about|vbscript|ftp):/i;

function buildCandidate(trimmed: string): string | null {
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (DISALLOWED_SCHEMES.test(trimmed)) return null;
  if (LOOPBACK_PATTERN.test(trimmed)) return `http://${trimmed}`;
  if (!trimmed.includes(".") && !trimmed.includes(":")) return null;
  return `https://${trimmed}`;
}

// Rewrite a loopback http(s) URL so the iframe loads it through the Rust
// `skein-preview://` proxy, which strips frame-blocking response headers.
// Non-loopback URLs are returned unchanged: they load directly and are
// subject to the browser's normal iframe policies (X-Frame-Options, CSP),
// so for sites like github.com / youtube.com users should use the
// "Open externally" button instead of forcing an embed.
export function toPreviewUrl(httpUrl: string): string {
  if (!httpUrl) return httpUrl;
  let parsed: URL;
  try {
    parsed = new URL(httpUrl);
  } catch {
    return httpUrl;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return httpUrl;
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return httpUrl;
  }
  return toLoopbackPreviewUrl(parsed) ?? httpUrl;
}

export function fromPreviewUrl(previewUrl: string): string | null {
  if (!previewUrl) return null;
  return parsePreviewTarget(previewUrl)?.toString() ?? null;
}
