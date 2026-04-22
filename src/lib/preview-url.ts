export const PREVIEW_SCHEME = "skein-preview";
const HOST_DELIMITER = "_";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

export function toLoopbackPreviewUrl(target: URL): string | null {
  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    !isLoopbackHost(target.hostname)
  ) {
    return null;
  }

  const scheme = target.protocol.slice(0, -1);
  const port = target.port ? `:${target.port}` : "";
  return `${PREVIEW_SCHEME}://${scheme}${HOST_DELIMITER}${target.hostname}${port}${target.pathname}${target.search}${target.hash}`;
}

export function parsePreviewTarget(previewUrl: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(previewUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${PREVIEW_SCHEME}:`) {
    return null;
  }

  const separator = parsed.hostname.indexOf(HOST_DELIMITER);
  if (separator === -1) {
    return null;
  }

  const scheme = parsed.hostname.slice(0, separator);
  const host = parsed.hostname.slice(separator + 1);
  if ((scheme !== "http" && scheme !== "https") || !isLoopbackHost(host)) {
    return null;
  }

  const port = parsed.port ? `:${parsed.port}` : "";
  return new URL(
    `${scheme}://${host}${port}${parsed.pathname}${parsed.search}${parsed.hash}`,
  );
}
