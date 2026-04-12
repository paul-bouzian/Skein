import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import * as bridge from "./lib/bridge";
import { makeWorkspaceSnapshot } from "./test/fixtures/conversation";
import { useAppUpdateStore } from "./stores/app-update-store";
import { useCodexUsageStore } from "./stores/codex-usage-store";
import { useConversationStore } from "./stores/conversation-store";
import { useFirstPromptRenameStore } from "./stores/first-prompt-rename-store";
import { useWorkspaceStore } from "./stores/workspace-store";
import { useWorktreeScriptStore } from "./stores/worktree-script-store";

vi.mock("./directions/studio/StudioShell", () => ({
  StudioShell: () => <div data-testid="studio-shell" />,
}));

vi.mock("./shared/LoadingState", () => ({
  LoadingState: () => <div data-testid="loading-state" />,
}));

vi.mock("./lib/bridge", () => ({
  listenToFirstPromptRenameFailures: vi.fn(async () => () => undefined),
  listenToMenuCheckForUpdates: vi.fn(async () => () => undefined),
}));

const mockedBridge = vi.mocked(bridge);

describe("App", () => {
  beforeEach(() => {
    mockedBridge.listenToMenuCheckForUpdates.mockReset();
    mockedBridge.listenToMenuCheckForUpdates.mockResolvedValue(() => undefined);

    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot(),
      loadingState: "ready",
      error: null,
      initialize: vi.fn(async () => undefined),
      initializeListener: vi.fn(async () => undefined),
    }));
    useConversationStore.setState((state) => ({
      ...state,
      listenerReady: true,
      initializeListener: vi.fn(async () => undefined),
    }));
    useCodexUsageStore.setState((state) => ({
      ...state,
      initializeListener: vi.fn(async () => undefined),
    }));
    useAppUpdateStore.setState((state) => ({
      ...state,
      initialize: vi.fn(async () => undefined),
      checkNow: vi.fn(async () => undefined),
    }));
    useWorktreeScriptStore.setState((state) => ({
      ...state,
      initializeListener: vi.fn(async () => undefined),
    }));
    useFirstPromptRenameStore.setState((state) => ({
      ...state,
      initializeListener: vi.fn(async () => undefined),
    }));
  });

  it("does not preload conversations during startup", async () => {
    render(<App />);

    await waitFor(() => {
      expect(vi.mocked(useConversationStore.getState().initializeListener)).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      useWorkspaceStore.setState((state) => ({
        ...state,
        snapshot: makeWorkspaceSnapshot(),
      }));
    });

    expect(mockedBridge.listenToMenuCheckForUpdates).toHaveBeenCalledTimes(1);
  });

  it("listens for app menu update checks", async () => {
    let callback: (() => void) | null = null;
    mockedBridge.listenToMenuCheckForUpdates.mockImplementation(async (next) => {
      callback = next;
      return () => undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(mockedBridge.listenToMenuCheckForUpdates).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      callback?.();
    });

    expect(vi.mocked(useAppUpdateStore.getState().checkNow)).toHaveBeenCalledTimes(1);
  });
});
