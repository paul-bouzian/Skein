import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeEnvironment, makeProject, makeThread, makeWorkspaceSnapshot } from "../test/fixtures/conversation";
import { useWorkspaceStore } from "./workspace-store";

vi.mock("../lib/bridge", () => ({
  getBootstrapStatus: vi.fn(),
  getWorkspaceSnapshot: vi.fn(),
}));

beforeEach(() => {
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: null,
    bootstrapStatus: null,
    loadingState: "ready",
    error: null,
    selectedProjectId: null,
    selectedEnvironmentId: null,
    selectedThreadId: null,
  }));
});

describe("workspace store", () => {
  it("selects the most recent active thread when an environment is chosen", () => {
    const snapshot = makeWorkspaceSnapshot({
      projects: [
        makeProject({
          environments: [
            makeEnvironment({
              threads: [
                makeThread({
                  id: "thread-older",
                  updatedAt: "2026-04-03T08:00:00Z",
                }),
                makeThread({
                  id: "thread-latest",
                  updatedAt: "2026-04-03T09:30:00Z",
                }),
              ],
            }),
          ],
        }),
      ],
    });

    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot,
    }));

    useWorkspaceStore.getState().selectEnvironment("env-1");

    const state = useWorkspaceStore.getState();
    expect(state.selectedProjectId).toBe("project-1");
    expect(state.selectedEnvironmentId).toBe("env-1");
    expect(state.selectedThreadId).toBe("thread-latest");
  });

  it("keeps the environment selected when clearing the active thread", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot(),
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
      selectedThreadId: "thread-1",
    }));

    useWorkspaceStore.getState().selectThread(null);

    const state = useWorkspaceStore.getState();
    expect(state.selectedProjectId).toBe("project-1");
    expect(state.selectedEnvironmentId).toBe("env-1");
    expect(state.selectedThreadId).toBeNull();
  });
});
