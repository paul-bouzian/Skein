// Scans terminal output (post-ANSI) for localhost URLs such as a dev server
// banner ("Local: http://localhost:5173/"). Designed to be fed with the raw
// chunks emitted by terminal-output-bus, including the fragment that may end
// on a partial URL. The caller is responsible for prepending the returned
// `remainder` to the next chunk so URLs split across bytes are recovered.
/* eslint-disable no-control-regex */
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;
const URL_PATTERN =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{1,5})?(?:\/[^\s\x1b]*)?/g;
/* eslint-enable no-control-regex */

const REMAINDER_SIZE = 64;

export type ScanResult = {
  urls: string[];
  remainder: string;
};

export function scanForLocalhostUrls(chunk: string): ScanResult {
  if (!chunk) return { urls: [], remainder: "" };
  const cleaned = chunk.replace(ANSI_ESCAPE, "");
  const matches = cleaned.match(URL_PATTERN) ?? [];
  const urls = matches
    .map((url) => url.replace(/[).,;:!?]+$/, ""))
    .filter((url) => url.length > 0);
  const remainder = chunk.slice(Math.max(0, chunk.length - REMAINDER_SIZE));
  return { urls, remainder };
}
