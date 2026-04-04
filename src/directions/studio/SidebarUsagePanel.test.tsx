import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeEnvironment, makeProject, makeWorkspaceSnapshot } from "../../test/fixtures/conversation";
import { useCodexUsageStore } from "../../stores/codex-usage-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { SidebarUsagePanel } from "./SidebarUsagePanel";

beforeEach(() => {
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: makeWorkspaceSnapshot({
      projects: [
        makeProject({
          environments: [
            makeEnvironment({
              id: "env-worktree",
              kind: "managedWorktree",
              name: "slate-hawk",
              isDefault: false,
            }),
          ],
        }),
      ],
    }),
    selectedProjectId: "project-1",
    selectedEnvironmentId: "env-worktree",
    selectedThreadId: null,
  }));
  useCodexUsageStore.setState((state) => ({
    ...state,
    snapshotsByEnvironmentId: {},
    loadingByEnvironmentId: {},
    errorByEnvironmentId: {},
    lastFetchedAtByEnvironmentId: {},
    listenerReady: false,
    ensureEnvironmentUsage: vi.fn(async () => {}),
  }));
});

describe("SidebarUsagePanel", () => {
  it("renders the session and weekly usage windows", () => {
    useCodexUsageStore.setState((state) => ({
      ...state,
      snapshotsByEnvironmentId: {
        "env-worktree": {
          primary: {
            usedPercent: 38,
            windowDurationMins: 300,
            resetsAt: 1_775_306_400,
          },
          secondary: {
            usedPercent: 12,
            windowDurationMins: 10_080,
            resetsAt: 1_775_910_400,
          },
        },
      },
    }));

    render(<SidebarUsagePanel />);

    expect(screen.getByText("Usage")).toBeInTheDocument();
    expect(screen.getByText("slate-hawk")).toBeInTheDocument();
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("38%")).toBeInTheDocument();
    expect(screen.getByText("12%")).toBeInTheDocument();
  });

  it("keeps the panel visible with a muted unavailable state", () => {
    useCodexUsageStore.setState((state) => ({
      ...state,
      errorByEnvironmentId: {
        "env-worktree": "Codex usage unavailable",
      },
    }));

    render(<SidebarUsagePanel />);

    expect(screen.getByText("Usage unavailable for this environment.")).toBeInTheDocument();
    expect(screen.getAllByText("--")).toHaveLength(2);
  });

  it("does not show an unavailable placeholder before the first fetch starts", () => {
    render(<SidebarUsagePanel />);

    expect(screen.queryByText("Usage unavailable for this environment.")).toBeNull();
    expect(screen.getAllByText("--")).toHaveLength(2);
  });
});
