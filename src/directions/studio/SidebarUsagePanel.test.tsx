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
    snapshot: null,
    loading: false,
    error: null,
    lastFetchedAt: null,
    listenerReady: false,
    ensureAccountUsage: vi.fn(async () => {}),
  }));
});

describe("SidebarUsagePanel", () => {
  it("renders the session and weekly usage windows", () => {
    useCodexUsageStore.setState((state) => ({
      ...state,
      snapshot: {
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
    }));

    render(<SidebarUsagePanel />);

    expect(screen.getByText("Usage")).toBeInTheDocument();
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("38%")).toBeInTheDocument();
    expect(screen.getByText("12%")).toBeInTheDocument();
  });

  it("keeps the panel visible with a muted unavailable state", () => {
    useCodexUsageStore.setState((state) => ({
      ...state,
      error: "Unable to resolve the Codex CLI binary.",
    }));

    render(<SidebarUsagePanel />);

    expect(screen.getByText("Unable to resolve the Codex CLI binary.")).toBeInTheDocument();
    expect(screen.getAllByText("--")).toHaveLength(2);
  });

  it("does not show an unavailable placeholder before the first fetch starts", () => {
    render(<SidebarUsagePanel />);

    expect(screen.queryByText("Usage unavailable for this account.")).toBeNull();
    expect(screen.getAllByText("--")).toHaveLength(2);
  });

  it("keeps the current usage visible during a background refresh", () => {
    useCodexUsageStore.setState((state) => ({
      ...state,
      snapshot: {
        primary: { usedPercent: 38 },
        secondary: { usedPercent: 12 },
      },
      loading: true,
    }));

    render(<SidebarUsagePanel />);

    expect(screen.getByText("38%")).toBeInTheDocument();
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("keeps cached usage visible without the empty-workspace placeholder", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({ projects: [] }),
      selectedProjectId: null,
      selectedEnvironmentId: null,
    }));
    useCodexUsageStore.setState((state) => ({
      ...state,
      snapshot: {
        primary: { usedPercent: 38 },
        secondary: { usedPercent: 12 },
      },
    }));

    render(<SidebarUsagePanel />);

    expect(screen.getByText("38%")).toBeInTheDocument();
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.queryByText("Add a project to inspect Codex usage.")).toBeNull();
  });
});
