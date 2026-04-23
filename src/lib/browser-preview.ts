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

// Matches any explicit URI scheme prefix (`scheme:` syntax). Used to
// reject non-`http(s)` schemes before prefixing heuristics kick in.
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// Matches a dotted-domain `host:port(/path/…)` form, which looks like a
// scheme prefix syntactically but is really a bare host. Loopback hosts
// are handled separately via `LOOPBACK_PATTERN`.
const DOMAIN_HOST_PORT =
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d+(?:[/?#]|$)/i;

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
  // Resolve bare `host:port` forms before the scheme check — otherwise
  // the leading `localhost` / `example.com` would look like a scheme.
  if (LOOPBACK_PATTERN.test(trimmed)) return `http://${trimmed}`;
  if (DOMAIN_HOST_PORT.test(trimmed)) return `https://${trimmed}`;
  // Any remaining `scheme:` prefix is explicitly non-http(s); reject it
  // so `mailto:…`, `ws://…`, `javascript:1`, etc. don't get rewritten.
  if (EXPLICIT_SCHEME.test(trimmed)) return null;
  if (!trimmed.includes(".") && !trimmed.includes(":")) return null;
  return `https://${trimmed}`;
}
