import { protocol } from "electron";
import { Agent } from "undici";

import {
  PREVIEW_SCHEME,
  isLoopbackHost,
  parsePreviewTarget,
} from "../src/lib/preview-url.js";

const MAX_REDIRECTS = 10;
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 30_000;
const BLOCKED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const BLOCKED_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
]);
const LOOPBACK_HTTPS_DISPATCHER = new Agent({
  connect: {
    rejectUnauthorized: false,
  },
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

function decodePreviewUrl(previewUrl: string) {
  return parsePreviewTarget(previewUrl);
}

function rewriteOriginHeader(value: string) {
  try {
    const decoded = decodePreviewUrl(value);
    if (!decoded) {
      return value;
    }

    return decoded.port
      ? `${decoded.protocol}//${decoded.hostname}:${decoded.port}`
      : `${decoded.protocol}//${decoded.hostname}`;
  } catch {
    return value;
  }
}

function rewriteRefererHeader(value: string) {
  try {
    return decodePreviewUrl(value)?.toString() ?? value;
  } catch {
    return value;
  }
}

function buildErrorResponse(status: number, message: string) {
  const body = `<!doctype html><meta charset="utf-8"><title>Skein browser error</title><body style="font-family:system-ui;padding:2rem;color:#f87171;"><h1>Can't reach this URL</h1><p>${escapeHtml(message)}</p></body>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sanitizeRequestHeaders(request: Request) {
  const forwarded = new Headers();
  request.headers.forEach((value, name) => {
    if (BLOCKED_REQUEST_HEADERS.has(name)) {
      return;
    }

    if (name === "origin") {
      forwarded.set(name, rewriteOriginHeader(value));
      return;
    }

    if (name === "referer") {
      forwarded.set(name, rewriteRefererHeader(value));
      return;
    }

    forwarded.set(name, value);
  });
  return forwarded;
}

function sanitizeResponseHeaders(headers: Headers) {
  const forwarded = new Headers();
  headers.forEach((value, name) => {
    if (!BLOCKED_RESPONSE_HEADERS.has(name)) {
      forwarded.set(name, value);
    }
  });
  return forwarded;
}

async function readBoundedBody(response: Response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    return { tooLarge: true as const, body: null };
  }

  if (!response.body) {
    return { tooLarge: false as const, body: new Uint8Array() };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      return { tooLarge: true as const, body: null };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { tooLarge: false as const, body };
}

async function readBoundedRequestBody(request: Request, method: string) {
  if (method === "GET" || method === "HEAD") {
    return { tooLarge: false as const, body: undefined };
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
    return { tooLarge: true as const, body: undefined };
  }

  if (!request.body) {
    return { tooLarge: false as const, body: undefined };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      return { tooLarge: true as const, body: undefined };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { tooLarge: false as const, body: Buffer.from(body) };
}

function collectSetCookies(headers: Headers) {
  const extendedHeaders = headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };
  if (typeof extendedHeaders.getSetCookie === "function") {
    return extendedHeaders.getSetCookie();
  }
  if (typeof extendedHeaders.raw === "function") {
    return extendedHeaders.raw()["set-cookie"] ?? [];
  }

  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

type RedirectCookie = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
};

function mergeCookieHeader(existingCookieHeader: string | null, fragments: string[]) {
  const cookies = new Map<string, string>();
  for (const fragment of (existingCookieHeader ?? "").split(";")) {
    const cookie = fragment.trim();
    if (!cookie) {
      continue;
    }
    const separatorIndex = cookie.indexOf("=");
    const name = separatorIndex >= 0 ? cookie.slice(0, separatorIndex) : cookie;
    cookies.set(name, cookie);
  }

  for (const fragment of fragments) {
    const cookie = fragment.trim();
    if (!cookie) {
      continue;
    }
    const separatorIndex = cookie.indexOf("=");
    const name = separatorIndex >= 0 ? cookie.slice(0, separatorIndex) : cookie;
    cookies.set(name, cookie);
  }

  return Array.from(cookies.values()).join("; ");
}

function defaultCookiePath(pathname: string) {
  if (!pathname.startsWith("/")) {
    return "/";
  }

  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function cookieDomainMatches(
  hostname: string,
  domain: string,
  hostOnly: boolean,
) {
  return hostOnly
    ? hostname === domain
    : hostname === domain || hostname.endsWith(`.${domain}`);
}

function cookiePathMatches(pathname: string, cookiePath: string) {
  if (pathname === cookiePath) {
    return true;
  }
  if (!pathname.startsWith(cookiePath)) {
    return false;
  }
  if (cookiePath.endsWith("/")) {
    return true;
  }
  return pathname.charAt(cookiePath.length) === "/";
}

function cookieKey(cookie: RedirectCookie) {
  return [
    cookie.name,
    cookie.domain,
    cookie.path,
    cookie.hostOnly ? "host" : "domain",
  ].join("|");
}

function parseRedirectCookie(setCookie: string, source: URL): RedirectCookie | null {
  const [cookiePair, ...attributePairs] = setCookie.split(";");
  const separatorIndex = cookiePair.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const name = cookiePair.slice(0, separatorIndex).trim();
  const value = cookiePair.slice(separatorIndex + 1).trim();
  if (!name) {
    return null;
  }

  const sourceHostname = source.hostname.toLowerCase();
  let domain = sourceHostname;
  let hostOnly = true;
  let path = defaultCookiePath(source.pathname);
  let secure = false;

  for (const attributePair of attributePairs) {
    const [rawName, ...rawValueParts] = attributePair.trim().split("=");
    const attributeName = rawName.toLowerCase();
    const attributeValue = rawValueParts.join("=").trim();

    if (attributeName === "domain") {
      if (!attributeValue) {
        return null;
      }

      const normalizedDomain = attributeValue.replace(/^\./u, "").toLowerCase();
      if (
        !normalizedDomain ||
        !cookieDomainMatches(sourceHostname, normalizedDomain, false)
      ) {
        return null;
      }
      domain = normalizedDomain;
      hostOnly = false;
      continue;
    }

    if (attributeName === "path") {
      if (attributeValue.startsWith("/")) {
        path = attributeValue;
      }
      continue;
    }

    if (attributeName === "secure") {
      secure = true;
    }
  }

  return {
    name,
    value,
    domain,
    hostOnly,
    path,
    secure,
  };
}

function mergeRedirectCookies(
  existingCookies: RedirectCookie[],
  setCookies: string[],
  source: URL,
) {
  const mergedCookies = new Map(
    existingCookies.map((cookie) => [cookieKey(cookie), cookie]),
  );

  for (const setCookie of setCookies) {
    const parsedCookie = parseRedirectCookie(setCookie, source);
    if (!parsedCookie) {
      continue;
    }
    mergedCookies.set(cookieKey(parsedCookie), parsedCookie);
  }

  return Array.from(mergedCookies.values());
}

function buildRedirectCookieHeader(cookies: RedirectCookie[], target: URL) {
  const matchedCookies = cookies
    .filter((cookie) => {
      if (
        !cookieDomainMatches(
          target.hostname.toLowerCase(),
          cookie.domain,
          cookie.hostOnly,
        )
      ) {
        return false;
      }
      if (!cookiePathMatches(target.pathname || "/", cookie.path)) {
        return false;
      }
      if (cookie.secure && target.protocol !== "https:") {
        return false;
      }
      return true;
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`);

  return matchedCookies.length > 0 ? matchedCookies.join("; ") : null;
}

async function fetchLoopbackTarget(
  request: Request,
  target: URL,
  redirectsRemaining = MAX_REDIRECTS,
  method = request.method,
  requestBody?: Buffer,
  requestCookieHeader?: string | null,
  redirectCookies: RedirectCookie[] = [],
): Promise<Response> {
  const requestBodyState =
    requestBody === undefined
      ? await readBoundedRequestBody(request, method)
      : { tooLarge: false as const, body: requestBody };
  if (requestBodyState.tooLarge) {
    return buildErrorResponse(
      413,
      `Request to ${target} exceeded the 20-MiB proxy limit.`,
    );
  }

  const body = requestBodyState.body;
  const headers = sanitizeRequestHeaders(request);
  const forwardedCookieHeader = mergeCookieHeader(
    requestCookieHeader === undefined ? headers.get("cookie") : requestCookieHeader,
    buildRedirectCookieHeader(redirectCookies, target)?.split("; ") ?? [],
  );
  if (forwardedCookieHeader) {
    headers.set("cookie", forwardedCookieHeader);
  } else {
    headers.delete("cookie");
  }
  if (body === undefined) {
    headers.delete("content-type");
  }
  const response = await fetch(target, {
    method,
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    ...(target.protocol === "https:"
      ? { dispatcher: LOOPBACK_HTTPS_DISPATCHER }
      : {}),
  });

  const isRedirect =
    response.status >= 300 && response.status < 400 && response.headers.has("location");
  if (isRedirect) {
    if (redirectsRemaining <= 0) {
      return buildErrorResponse(508, "The preview URL redirected too many times.");
    }

    const location = response.headers.get("location");
    const next = new URL(location!, target);
    if (
      (next.protocol !== "http:" && next.protocol !== "https:") ||
      !isLoopbackHost(next.hostname)
    ) {
      return buildErrorResponse(
        403,
        "The integrated browser only proxies loopback URLs.",
      );
    }

    const nextRequest = rewriteRedirectRequest(response.status, method, body);
    const nextRedirectCookies = mergeRedirectCookies(
      redirectCookies,
      collectSetCookies(response.headers),
      target,
    );

    return fetchLoopbackTarget(
      request,
      next,
      redirectsRemaining - 1,
      nextRequest.method,
      nextRequest.body,
      null,
      nextRedirectCookies,
    );
  }

  return response;
}

function rewriteRedirectRequest(
  status: number,
  method: string,
  body: Buffer | undefined,
) {
  if (status === 303 && method !== "HEAD") {
    return { method: "GET", body: undefined };
  }

  if ((status === 301 || status === 302) && method === "POST") {
    return { method: "GET", body: undefined };
  }

  return { method, body };
}

async function handlePreviewRequest(request: Request) {
  let target: URL | null = null;
  try {
    target = decodePreviewUrl(request.url);
  } catch {
    target = null;
  }

  if (!target) {
    return buildErrorResponse(
      403,
      "The integrated browser only proxies loopback URLs.",
    );
  }

  try {
    const response = await fetchLoopbackTarget(request, target);
    const { tooLarge, body } = await readBoundedBody(response);
    if (tooLarge) {
      return buildErrorResponse(
        413,
        `Response from ${target} exceeded the 20-MiB proxy limit.`,
      );
    }

    return new Response(body, {
      status: response.status,
      headers: sanitizeResponseHeaders(response.headers),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildErrorResponse(
      502,
      `Failed to reach ${target}: ${message}`,
    );
  }
}

export async function registerPreviewProtocol() {
  if (protocol.isProtocolHandled(PREVIEW_SCHEME)) {
    protocol.unhandle(PREVIEW_SCHEME);
  }

  protocol.handle(PREVIEW_SCHEME, handlePreviewRequest);
}
