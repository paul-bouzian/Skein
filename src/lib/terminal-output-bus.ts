import * as bridge from "./bridge";

// Cap the per-ptyId pre-subscribe buffer. Guards against runaway output if a
// TerminalView never mounts for whatever reason (e.g., tab closed before the
// React render cycle produced the view). In normal operation the buffer
// holds a handful of bytes — the window between spawnTerminal resolving and
// TerminalView mounting is measured in single-digit milliseconds.
const MAX_BUFFERED_BYTES = 64 * 1024;

type OutputListener = (bytes: Uint8Array) => void;

const activeListeners = new Map<string, OutputListener>();
const pendingBuffers = new Map<string, Uint8Array>();
let subscriptionPromise: Promise<void> | null = null;

function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function appendToPending(ptyId: string, bytes: Uint8Array) {
  const existing = pendingBuffers.get(ptyId);
  if (!existing) {
    if (bytes.byteLength <= MAX_BUFFERED_BYTES) {
      pendingBuffers.set(ptyId, bytes);
    } else {
      pendingBuffers.set(
        ptyId,
        bytes.subarray(bytes.byteLength - MAX_BUFFERED_BYTES).slice(),
      );
    }
    return;
  }
  const combinedLength = existing.byteLength + bytes.byteLength;
  if (combinedLength <= MAX_BUFFERED_BYTES) {
    const merged = new Uint8Array(combinedLength);
    merged.set(existing);
    merged.set(bytes, existing.byteLength);
    pendingBuffers.set(ptyId, merged);
    return;
  }
  // Overflow: keep the most recent MAX_BUFFERED_BYTES bytes.
  const merged = new Uint8Array(MAX_BUFFERED_BYTES);
  const combined = new Uint8Array(combinedLength);
  combined.set(existing);
  combined.set(bytes, existing.byteLength);
  merged.set(combined.subarray(combinedLength - MAX_BUFFERED_BYTES));
  pendingBuffers.set(ptyId, merged);
}

function handleOutput(ptyId: string, bytes: Uint8Array) {
  const listener = activeListeners.get(ptyId);
  if (listener) {
    listener(bytes);
    return;
  }
  appendToPending(ptyId, bytes);
}

/**
 * Attach the module-level terminal output subscription if it isn't already
 * attached. Safe to call multiple times; subsequent calls return the same
 * Promise. Must be awaited before spawning a PTY so pre-subscribe output
 * reaches the pending buffer instead of being dropped.
 */
export function ensureTerminalOutputBusReady(): Promise<void> {
  if (subscriptionPromise) return subscriptionPromise;
  subscriptionPromise = bridge
    .listenToTerminalOutput((payload) => {
      handleOutput(payload.ptyId, decodeBase64(payload.dataBase64));
    })
    .then(() => undefined)
    .catch((error) => {
      subscriptionPromise = null;
      throw error;
    });
  return subscriptionPromise;
}

/**
 * Register a listener for output from a specific PTY. Any output received by
 * the bus BEFORE this subscription is flushed synchronously before
 * subscribeToTerminalOutput returns. Returns an unsubscribe function that
 * removes the listener only if it is still the active one for that ptyId.
 */
export function subscribeToTerminalOutput(
  ptyId: string,
  listener: OutputListener,
): () => void {
  activeListeners.set(ptyId, listener);
  const pending = pendingBuffers.get(ptyId);
  if (pending) {
    pendingBuffers.delete(ptyId);
    listener(pending);
  }
  return () => {
    if (activeListeners.get(ptyId) === listener) {
      activeListeners.delete(ptyId);
    }
  };
}

/**
 * Drop any buffered output for a ptyId that will never be consumed (e.g.,
 * the tab was closed without ever mounting a view). Prevents pending buffers
 * from leaking memory across killed sessions.
 */
export function dropPendingTerminalOutput(ptyId: string): void {
  pendingBuffers.delete(ptyId);
}

/**
 * Test-only: reset the bus to a clean state. Used between tests to avoid
 * cross-test contamination of buffers and listener state.
 */
export function __resetTerminalOutputBus(): void {
  activeListeners.clear();
  pendingBuffers.clear();
  subscriptionPromise = null;
}
