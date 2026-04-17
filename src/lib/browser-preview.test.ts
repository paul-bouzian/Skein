import { describe, expect, it } from "vitest";

import {
  fromPreviewUrl,
  isLoopbackHost,
  normalizeBrowserUrl,
  toPreviewUrl,
} from "./browser-preview";

describe("normalizeBrowserUrl", () => {
  it("prefixes http:// to bare localhost", () => {
    expect(normalizeBrowserUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeBrowserUrl("127.0.0.1:8000")).toBe("http://127.0.0.1:8000/");
  });

  it("keeps explicit protocol", () => {
    expect(normalizeBrowserUrl("https://github.com")).toBe("https://github.com/");
  });

  it("rejects a bare word (no dot, no colon)", () => {
    expect(normalizeBrowserUrl("hello")).toBeNull();
  });

  it("prefixes https:// for domains", () => {
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com/");
  });

  it("returns null for empty input", () => {
    expect(normalizeBrowserUrl("   ")).toBeNull();
  });

  it("rejects malformed host:port combinations", () => {
    expect(normalizeBrowserUrl("example.com:abc")).toBeNull();
    expect(normalizeBrowserUrl("localhost:abc")).toBeNull();
  });

  it("rejects non-http protocols", () => {
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserUrl("file:///etc/passwd")).toBeNull();
  });

  it("does not treat IPv6 loopback as loopback (unsupported by proxy)", () => {
    // The preview scheme can't encode bracketed hosts, so `[::1]` is not
    // considered loopback here. The input still parses as a valid URL
    // (so users get a chance to visit it), but toPreviewUrl leaves it
    // alone and the iframe loads it directly subject to the browser's
    // normal policies.
    const result = normalizeBrowserUrl("http://[::1]:8080/");
    expect(result).toBe("http://[::1]:8080/");
    expect(toPreviewUrl(result!)).toBe("http://[::1]:8080/");
  });
});

describe("isLoopbackHost", () => {
  it("accepts loopback hostnames", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});

describe("toPreviewUrl", () => {
  it("rewrites loopback http URLs", () => {
    expect(toPreviewUrl("http://localhost:3000/fr")).toBe(
      "skein-preview://http_localhost:3000/fr",
    );
    expect(toPreviewUrl("http://127.0.0.1:5173/")).toBe(
      "skein-preview://http_127.0.0.1:5173/",
    );
  });

  it("preserves query string and hash on loopback URLs", () => {
    expect(
      toPreviewUrl("http://localhost:5173/path?q=1&r=2#section"),
    ).toBe("skein-preview://http_localhost:5173/path?q=1&r=2#section");
  });

  it("does not rewrite non-loopback URLs", () => {
    expect(toPreviewUrl("https://example.com/path")).toBe(
      "https://example.com/path",
    );
  });

  it("does not rewrite about:blank or malformed input", () => {
    expect(toPreviewUrl("about:blank")).toBe("about:blank");
    expect(toPreviewUrl("not a url")).toBe("not a url");
  });

  it("leaves skein-preview URLs alone", () => {
    const already = "skein-preview://http_localhost:3000/";
    expect(toPreviewUrl(already)).toBe(already);
  });
});

describe("fromPreviewUrl", () => {
  it("decodes a preview URL back to the original", () => {
    expect(
      fromPreviewUrl("skein-preview://http_localhost:3000/fr"),
    ).toBe("http://localhost:3000/fr");
  });

  it("returns null for a non-preview URL", () => {
    expect(fromPreviewUrl("http://localhost:3000/")).toBeNull();
  });

  it("returns null for a non-loopback decoded host", () => {
    expect(fromPreviewUrl("skein-preview://http_example.com/")).toBeNull();
  });

  it("returns null for a malformed preview URL", () => {
    expect(fromPreviewUrl("skein-preview://missing-delimiter/")).toBeNull();
  });
});
