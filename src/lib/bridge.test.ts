import { beforeEach, describe, expect, it, vi } from "vitest";

import { CONVERSATION_EVENT_NAMES } from "./app-identity";
import { listenToConversationEvents } from "./bridge";

const invokeMock = vi.fn();
const listenersByEventName = new Map<
  string,
  Set<(event: { payload: unknown }) => void>
>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (eventName: string, callback: (event: { payload: unknown }) => void) => {
      const listeners = listenersByEventName.get(eventName) ?? new Set();
      listeners.add(callback);
      listenersByEventName.set(eventName, listeners);

      return () => {
        listeners.delete(callback);
        if (listeners.size === 0) {
          listenersByEventName.delete(eventName);
        }
      };
    },
  ),
}));

function emit(eventName: string, payload: unknown) {
  for (const callback of listenersByEventName.get(eventName) ?? []) {
    callback({ payload });
  }
}

beforeEach(() => {
  invokeMock.mockReset();
  listenersByEventName.clear();
});

describe("bridge event namespace migration", () => {
  it("registers conversation listeners for Skein and legacy namespaces", async () => {
    const unlisten = await listenToConversationEvents(() => undefined);

    expect([...listenersByEventName.keys()]).toEqual(
      expect.arrayContaining([...CONVERSATION_EVENT_NAMES]),
    );

    unlisten();

    expect(listenersByEventName.size).toBe(0);
  });

  it("commits to the Skein namespace when the new event fires first", async () => {
    const callback = vi.fn();
    const [skeinEventName, legacyEventName] = CONVERSATION_EVENT_NAMES;
    await listenToConversationEvents(callback);

    emit(skeinEventName, { kind: "skein" });
    emit(legacyEventName, { kind: "legacy" });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ kind: "skein" });
    expect([...listenersByEventName.keys()]).toEqual([skeinEventName]);
  });

  it("falls back to the legacy namespace when only legacy events are available", async () => {
    const callback = vi.fn();
    const [skeinEventName, legacyEventName] = CONVERSATION_EVENT_NAMES;
    await listenToConversationEvents(callback);

    emit(legacyEventName, { kind: "legacy" });
    emit(skeinEventName, { kind: "skein" });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ kind: "legacy" });
    expect([...listenersByEventName.keys()]).toEqual([legacyEventName]);
  });
});
