import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  desktopInvokeMock,
  desktopListenMock,
} from "../test/desktop-mock";
import { invokeCommand, listenEvent } from "./desktop-host";

describe("desktop-host", () => {
  beforeEach(() => {
    desktopInvokeMock.mockReset();
    desktopListenMock.mockReset();
  });

  it("routes invoke through the exposed desktop host", async () => {
    desktopInvokeMock.mockResolvedValue("desktop");

    await expect(invokeCommand("ping", { value: 1 })).resolves.toBe("desktop");
    expect(desktopInvokeMock).toHaveBeenCalledWith("ping", { value: 1 });
  });

  it("routes listeners through the exposed desktop host", async () => {
    const unlisten = vi.fn();
    const handler = vi.fn();
    desktopListenMock.mockResolvedValue(unlisten);

    const cleanup = await listenEvent("skein://event", handler);

    expect(desktopListenMock).toHaveBeenCalledWith("skein://event", handler);
    expect(cleanup).toBe(unlisten);
  });

  it("fails fast when the desktop host is absent", async () => {
    delete window.skeinDesktop;

    expect(() => invokeCommand("ping")).toThrow(
      "Desktop host is unavailable",
    );
  });
});
