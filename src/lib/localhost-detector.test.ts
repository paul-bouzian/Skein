import { describe, expect, it } from "vitest";

import { scanForLocalhostUrls } from "./localhost-detector";

describe("scanForLocalhostUrls", () => {
  it("matches plain http://localhost:PORT", () => {
    const { urls } = scanForLocalhostUrls("Local: http://localhost:5173/\n");
    expect(urls).toEqual(["http://localhost:5173/"]);
  });

  it("matches 127.0.0.1 and 0.0.0.0", () => {
    const chunk = "API: http://127.0.0.1:3000 bound on http://0.0.0.0:8080";
    const { urls } = scanForLocalhostUrls(chunk);
    expect(urls).toEqual(["http://127.0.0.1:3000", "http://0.0.0.0:8080"]);
  });

  it("ignores IPv6 loopback (unsupported by preview proxy)", () => {
    const { urls } = scanForLocalhostUrls("socket: http://[::1]:8080/ws");
    expect(urls).toEqual([]);
  });

  it("strips ANSI color escapes before matching", () => {
    const chunk = "\x1b[32mLocal:\x1b[0m \x1b[36mhttp://localhost:5173/\x1b[0m";
    const { urls } = scanForLocalhostUrls(chunk);
    expect(urls).toEqual(["http://localhost:5173/"]);
  });

  it("ignores non-localhost URLs", () => {
    const { urls } = scanForLocalhostUrls(
      "Visit https://github.com and http://example.com",
    );
    expect(urls).toEqual([]);
  });

  it("trims trailing punctuation", () => {
    const { urls } = scanForLocalhostUrls("Open (http://localhost:3000).");
    expect(urls).toEqual(["http://localhost:3000"]);
  });

  it("returns a remainder of up to REMAINDER_SIZE chars", () => {
    const prefix = "x".repeat(200);
    const { remainder } = scanForLocalhostUrls(prefix);
    expect(remainder.length).toBe(64);
    expect(remainder).toBe("x".repeat(64));
  });

  it("returns empty for empty input", () => {
    expect(scanForLocalhostUrls("")).toEqual({ urls: [], remainder: "" });
  });

  it("matches https://localhost", () => {
    const { urls } = scanForLocalhostUrls("use https://localhost:8443/api");
    expect(urls).toEqual(["https://localhost:8443/api"]);
  });

  it("matches localhost without port", () => {
    const { urls } = scanForLocalhostUrls("try http://localhost/ now");
    expect(urls).toEqual(["http://localhost/"]);
  });
});
