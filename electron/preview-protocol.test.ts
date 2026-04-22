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

  it("rewrites POST redirects to GET for 303 responses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 303,
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

      const protocolHandler = handleMock.mock.calls.at(-1)?.[1] as
        | ((request: Request) => Promise<Response>)
        | undefined;
      expect(protocolHandler).toBeTypeOf("function");

      const request = new Request("skein-preview://http_localhost:3000/login", {
        method: "POST",
        body: "email=skein@example.com",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
      });

      const response = await protocolHandler!(request);

      expect(response.status).toBe(200);
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
        method: "GET",
        body: undefined,
      });
      expect(
        (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.headers,
      ).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allows loopback https previews to use the insecure dispatcher", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("secure", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { registerPreviewProtocol } = await import("./preview-protocol.js");
      await registerPreviewProtocol();

      const protocolHandler = handleMock.mock.calls.at(-1)?.[1] as
        | ((request: Request) => Promise<Response>)
        | undefined;
      expect(protocolHandler).toBeTypeOf("function");

      const request = new Request("skein-preview://https_localhost:3443/");
      await protocolHandler!(request);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const options = fetchMock.mock.calls[0]?.[1] as
        | ({ dispatcher?: unknown } & RequestInit)
        | undefined;
      expect(options?.dispatcher).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("carries session cookies across redirect hops", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 303,
          headers: {
            location: "/done",
            "set-cookie": "session=skein; Path=/; HttpOnly",
          },
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

      const protocolHandler = handleMock.mock.calls.at(-1)?.[1] as
        | ((request: Request) => Promise<Response>)
        | undefined;
      expect(protocolHandler).toBeTypeOf("function");

      const request = new Request("skein-preview://http_localhost:3000/login", {
        method: "POST",
        body: "email=skein@example.com",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
      });

      const response = await protocolHandler!(request);

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
        method: "GET",
        body: undefined,
      });
      const headers = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)
        ?.headers as Headers | undefined;
      expect(headers?.get("cookie")).toBe("session=skein");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not forward redirect cookies to a different loopback origin", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 303,
          headers: {
            location: "http://127.0.0.1:4000/done",
            "set-cookie": "session=skein; Path=/; HttpOnly",
          },
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

      const protocolHandler = handleMock.mock.calls.at(-1)?.[1] as
        | ((request: Request) => Promise<Response>)
        | undefined;
      expect(protocolHandler).toBeTypeOf("function");

      const request = new Request("skein-preview://http_localhost:3000/login", {
        method: "POST",
        body: "email=skein@example.com",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
      });

      const response = await protocolHandler!(request);

      expect(response.status).toBe(200);
      const headers = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)
        ?.headers as Headers | undefined;
      expect(headers?.get("cookie")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not forward secure redirect cookies after downgrading to http", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 303,
          headers: {
            location: "http://localhost:3000/done",
            "set-cookie": "session=skein; Path=/; Secure",
          },
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

      const protocolHandler = handleMock.mock.calls.at(-1)?.[1] as
        | ((request: Request) => Promise<Response>)
        | undefined;
      expect(protocolHandler).toBeTypeOf("function");

      const request = new Request("skein-preview://https_localhost:3443/login", {
        method: "POST",
        body: "email=skein@example.com",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
      });

      const response = await protocolHandler!(request);

      expect(response.status).toBe(200);
      const headers = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)
        ?.headers as Headers | undefined;
      expect(headers?.get("cookie")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects oversized buffered request bodies before forwarding", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { registerPreviewProtocol } = await import("./preview-protocol.js");
      await registerPreviewProtocol();

      const protocolHandler = handleMock.mock.calls.at(-1)?.[1] as
        | ((request: Request) => Promise<Response>)
        | undefined;
      expect(protocolHandler).toBeTypeOf("function");

      const request = new Request("skein-preview://http_localhost:3000/upload", {
        method: "POST",
        body: "tiny",
        headers: {
          "content-length": String(20 * 1024 * 1024 + 1),
        },
      });

      const response = await protocolHandler!(request);

      expect(response.status).toBe(413);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
