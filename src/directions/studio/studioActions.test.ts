import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  makeEnvironment,
  makeThread,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { selectAdjacentThread } from "./studioActions";

describe("studioActions", () => {
  beforeEach(() => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          {
            ...makeWorkspaceSnapshot().projects[0]!,
            environments: [
              makeEnvironment({
                threads: [
                  makeThread({ id: "thread-1", title: "Thread 1" }),
                  makeThread({ id: "thread-2", title: "Thread 2" }),
                ],
              }),
            ],
          },
        ],
      }),
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
      selectedThreadId: null,
      selectThread: vi.fn((threadId: string | null) =>
        useWorkspaceStore.setState((current) => ({ ...current, selectedThreadId: threadId })),
      ),
    }));
  });

  it("selects the first active thread when navigating next with no current selection", () => {
    expect(selectAdjacentThread("next")).toBe(true);
    expect(useWorkspaceStore.getState().selectedThreadId).toBe("thread-1");
  });
});
