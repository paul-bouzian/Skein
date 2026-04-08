import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { makeWorkspaceSnapshot } from "./test/fixtures/conversation";
import { useAppUpdateStore } from "./stores/app-update-store";
import { useCodexUsageStore } from "./stores/codex-usage-store";
import { useConversationStore } from "./stores/conversation-store";
import { useWorkspaceStore } from "./stores/workspace-store";
import { useWorktreeScriptStore } from "./stores/worktree-script-store";

vi.mock("./directions/studio/StudioShell", () => ({
  StudioShell: () => <div data-testid="studio-shell" />,
}));

vi.mock("./shared/LoadingState", () => ({
  LoadingState: () => <div data-testid="loading-state" />,
}));

describe("App", () => {
  beforeEach(() => {
    const preloadActiveThreads = vi.fn(async () => undefined);

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
      preloadActiveThreads,
    }));
    useCodexUsageStore.setState((state) => ({
      ...state,
      initializeListener: vi.fn(async () => undefined),
    }));
    useAppUpdateStore.setState((state) => ({
      ...state,
      initialize: vi.fn(async () => undefined),
    }));
    useWorktreeScriptStore.setState((state) => ({
      ...state,
      initializeListener: vi.fn(async () => undefined),
    }));
  });

  it("preloads active threads only once after startup readiness", async () => {
    render(<App />);

    await waitFor(() => {
      expect(
        vi.mocked(useConversationStore.getState().preloadActiveThreads),
      ).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      useWorkspaceStore.setState((state) => ({
        ...state,
        snapshot: makeWorkspaceSnapshot(),
      }));
    });

    expect(
      vi.mocked(useConversationStore.getState().preloadActiveThreads),
    ).toHaveBeenCalledTimes(1);
  });
});
