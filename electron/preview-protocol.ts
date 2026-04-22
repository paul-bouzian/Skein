import { protocol } from "electron";

import {
  PREVIEW_SCHEME,
  isLoopbackHost,
  parsePreviewTarget,
} from "../src/lib/preview-url.js";

const MAX_REDIRECTS = 10;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 30_000;
const BLOCKED_REQUEST_HEADERS = new Set([
  "connection",
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

async function fetchLoopbackTarget(
  request: Request,
  target: URL,
  redirectsRemaining = MAX_REDIRECTS,
  requestBody?: Buffer,
): Promise<Response> {
  const body =
    requestBody ??
    (request.method === "GET" || request.method === "HEAD"
      ? undefined
      : Buffer.from(await request.arrayBuffer()));
  const response = await fetch(target, {
    method: request.method,
    headers: sanitizeRequestHeaders(request),
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
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

    return fetchLoopbackTarget(request, next, redirectsRemaining - 1, body);
  }

  return response;
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
