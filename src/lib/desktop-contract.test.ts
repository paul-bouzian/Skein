import { describe, expect, it } from "vitest";

import {
  assertDesktopBackendCommand,
  assertDesktopEventName,
  assertDesktopPayload,
  assertOpenExternalUrl,
} from "./desktop-contract";

describe("desktop contract", () => {
  it("accepts supported backend commands and plain-object payloads", () => {
    expect(assertDesktopBackendCommand("get_workspace_snapshot")).toBe(
      "get_workspace_snapshot",
    );
    expect(assertDesktopPayload({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
  });

  it("rejects unsupported backend commands and malformed payloads", () => {
    expect(() => assertDesktopBackendCommand("launch_missiles")).toThrow(
      "Unsupported desktop command",
    );
    expect(() => assertDesktopPayload(["nope"])).toThrow(
      "Desktop payload must be a plain object.",
    );
  });

  it("accepts only allowed desktop event names", () => {
    expect(assertDesktopEventName("skein://workspace-event")).toBe(
      "skein://workspace-event",
    );
    expect(() => assertDesktopEventName("skein://totally-unknown")).toThrow(
      "Unsupported desktop event",
    );
  });

  it("allows only trusted external URL schemes", () => {
    expect(assertOpenExternalUrl("https://example.com/releases")).toBe(
      "https://example.com/releases",
    );
    expect(assertOpenExternalUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/",
    );
    expect(() => assertOpenExternalUrl("http://example.com")).toThrow(
      "Only https URLs, mailto links, and loopback http URLs can be opened externally.",
    );
  });
});
