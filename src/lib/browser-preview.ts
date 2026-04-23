// URL helpers for the integrated browser.
//
// `normalizeBrowserUrl` prepares raw text typed in the address bar:
// it accepts explicit http(s) URLs, auto-prefixes bare localhost with
// `http://`, auto-prefixes anything dotted with `https://`, and rejects
// unstructured input so the bar never doubles as a search box.
//
// `isLoopbackHost` is exported for callers that distinguish local dev
// servers from public URLs (e.g. the "open externally" allow-list).

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

const LOOPBACK_PATTERN =
  /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

const DISALLOWED_SCHEMES = /^(file|javascript|data|about|vbscript|ftp):/i;

// The URL parser strips brackets from IPv6 hostnames (`[::1]` → `::1`),
// so we match both forms here so callers can pass either the raw
// `hostname` field or the bracketed form.
export function isLoopbackHost(hostname: string): boolean {
  if (!hostname) return false;
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return LOOPBACK_HOSTS.has(hostname.slice(1, -1));
  }
  return false;
}

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

function buildCandidate(trimmed: string): string | null {
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (DISALLOWED_SCHEMES.test(trimmed)) return null;
  if (LOOPBACK_PATTERN.test(trimmed)) return `http://${trimmed}`;
  if (!trimmed.includes(".") && !trimmed.includes(":")) return null;
  return `https://${trimmed}`;
}
