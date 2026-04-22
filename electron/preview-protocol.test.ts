import { beforeEach, describe, expect, it, vi } from "vitest";

const handleMock = vi.fn();
const isProtocolHandledMock = vi.fn(() => false);
const unhandleMock = vi.fn();
const registerSchemesAsPrivilegedMock = vi.fn();

vi.mock("electron", () => ({
  protocol: {
    handle: handleMock,
    isProtocolHandled: isProtocolHandledMock,
    registerSchemesAsPrivileged: registerSchemesAsPrivilegedMock,
    unhandle: unhandleMock,
  },
}));

describe("preview protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isProtocolHandledMock.mockReturnValue(false);
  });

  it("reuses the buffered request body across redirect hops", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "/done" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { registerPreviewProtocol } = await import("./preview-protocol.js");
      await registerPreviewProtocol();

      const protocolHandler = handleMock.mock.calls[0]?.[1] as
        | ((request: Request) => Promise<Response>)
        | undefined;
      expect(protocolHandler).toBeTypeOf("function");

      const request = new Request("skein-preview://http_localhost:3000/form", {
        method: "POST",
        body: "name=skein",
        headers: {
          origin: "skein-preview://http_localhost:3000",
          referer: "skein-preview://http_localhost:3000/form",
        },
      });

      const response = await protocolHandler!(request);

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[0]).toEqual(
        new URL("http://localhost:3000/form"),
      );
      expect(fetchMock.mock.calls[1]?.[0]).toEqual(
        new URL("http://localhost:3000/done"),
      );
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
        body: Buffer.from("name=skein"),
      });
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
        method: "POST",
        body: Buffer.from("name=skein"),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
