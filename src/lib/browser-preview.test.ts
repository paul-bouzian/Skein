import { describe, expect, it } from "vitest";

import { isLoopbackHost, normalizeBrowserUrl } from "./browser-preview";

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

  it("accepts bracketed IPv6 hosts without rewriting", () => {
    const result = normalizeBrowserUrl("http://[::1]:8080/");
    expect(result).toBe("http://[::1]:8080/");
  });
});

describe("isLoopbackHost", () => {
  it("accepts loopback hostnames", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(true);
  });

  it("accepts IPv6 loopback in both raw and bracketed form", () => {
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
    expect(isLoopbackHost("::2")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});
