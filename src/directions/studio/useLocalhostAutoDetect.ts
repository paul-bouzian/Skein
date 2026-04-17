import { useEffect, useRef } from "react";

import { subscribeToTerminalOutput } from "../../lib/terminal-output-bus";
import { scanForLocalhostUrls } from "../../lib/localhost-detector";
import { useBrowserStore } from "../../stores/browser-store";
import { useTerminalStore } from "../../stores/terminal-store";

type PtySubscription = {
  unsubscribe: () => void;
  decoder: TextDecoder;
  tail: string;
  environmentId: string;
};

type PtyBinding = {
  ptyId: string;
  environmentId: string;
};

function selectPtyBindings(
  state: ReturnType<typeof useTerminalStore.getState>,
): PtyBinding[] {
  const bindings: PtyBinding[] = [];
  for (const [environmentId, slot] of Object.entries(state.byEnv)) {
    for (const tab of slot.tabs) {
      bindings.push({ ptyId: tab.ptyId, environmentId });
    }
  }
  bindings.sort((a, b) => a.ptyId.localeCompare(b.ptyId));
  return bindings;
}

function bindingsKey(bindings: PtyBinding[]): string {
  return bindings
    .map((binding) => `${binding.ptyId}\u0001${binding.environmentId}`)
    .join("\u0000");
}

// Subscribes to every live PTY and pushes any localhost URL that appears
// in the terminal output to the browser store's `detectedUrls` for the
// PTY's owning environment. URLs detected in environment A never feed
// suggestions for environment B, so switching worktrees doesn't
// cross-pollinate dev-server URLs.
//
// Subscriptions are diffed incrementally: adding or removing one terminal
// does not re-subscribe the others, avoiding replays that would promote
// stale URLs back to the head of the LRU. Each PTY keeps its own
// streaming decoder and tail buffer so interleaved UTF-8 chunks from
// different terminals don't corrupt each other.
export function useLocalhostAutoDetect(): void {
  const bindingsKeyValue = useTerminalStore((state) =>
    bindingsKey(selectPtyBindings(state)),
  );
  const subsRef = useRef<Map<string, PtySubscription>>(new Map());

  useEffect(() => {
    const subs = subsRef.current;
    const bindings = selectPtyBindings(useTerminalStore.getState());
    const nextMap = new Map(bindings.map((b) => [b.ptyId, b.environmentId]));
    const reportDetectedUrl = useBrowserStore.getState().reportDetectedUrl;

    for (const [ptyId, sub] of subs) {
      const nextEnv = nextMap.get(ptyId);
      if (!nextEnv || nextEnv !== sub.environmentId) {
        sub.unsubscribe();
        subs.delete(ptyId);
      }
    }

    for (const [ptyId, environmentId] of nextMap) {
      if (subs.has(ptyId)) continue;
      const entry: PtySubscription = {
        decoder: new TextDecoder(),
        tail: "",
        environmentId,
        unsubscribe: () => undefined,
      };
      entry.unsubscribe = subscribeToTerminalOutput(ptyId, (bytes) => {
        const chunk = entry.tail + entry.decoder.decode(bytes, { stream: true });
        const { urls, remainder } = scanForLocalhostUrls(chunk);
        entry.tail = remainder;
        for (const url of urls) {
          reportDetectedUrl(entry.environmentId, url);
        }
      });
      subs.set(ptyId, entry);
    }
  }, [bindingsKeyValue]);

  useEffect(() => {
    const subs = subsRef.current;
    return () => {
      for (const sub of subs.values()) {
        sub.unsubscribe();
      }
      subs.clear();
    };
  }, []);
}
