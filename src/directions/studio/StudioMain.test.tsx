import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  makeEnvironment,
  makeProject,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { useTerminalStore } from "../../stores/terminal-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { StudioMain } from "./StudioMain";

vi.mock("../../shared/EnvironmentKindBadge", () => ({
  EnvironmentKindBadge: () => <div data-testid="environment-kind-badge" />,
}));

vi.mock("../../shared/RuntimeIndicator", () => ({
  RuntimeIndicator: () => <div data-testid="runtime-indicator" />,
}));

vi.mock("../../shared/Icons", () => ({
  PanelLeftIcon: () => <span data-testid="icon-panel-left" />,
  PanelRightIcon: () => <span data-testid="icon-panel-right" />,
  TerminalIcon: () => <span data-testid="icon-terminal" />,
  ThreadIcon: () => <span data-testid="icon-thread" />,
}));

vi.mock("./EnvironmentActionControl", () => ({
  EnvironmentActionControl: () => <div data-testid="environment-action-control" />,
}));

vi.mock("./OpenEnvironmentControl", () => ({
  OpenEnvironmentControl: () => <div data-testid="open-environment-control" />,
}));

vi.mock("./ThreadTabs", () => ({
  ThreadTabs: () => <div data-testid="thread-tabs" />,
}));

vi.mock("./ThreadConversation", () => ({
  ThreadConversation: () => <div data-testid="thread-conversation" />,
}));

vi.mock("./StudioWelcome", () => ({
  StudioWelcome: () => <div data-testid="studio-welcome" />,
}));

vi.mock("./TerminalPanel", () => ({
  TerminalPanel: () => <div data-testid="terminal-panel" />,
}));

function makeTerminalTab(id: string, ptyId: string, title: string) {
  return {
    id,
    ptyId,
    title,
    cwd: `/tmp/${title}`,
    exited: false,
    kind: "shell" as const,
  };
}

beforeEach(() => {
  const snapshot = makeWorkspaceSnapshot({
    projects: [
      makeProject({
        environments: [
          makeEnvironment({
            id: "env-1",
            path: "/tmp/env-1",
            threads: [],
          }),
          makeEnvironment({
            id: "env-2",
            path: "/tmp/env-2",
            threads: [],
            isDefault: false,
          }),
        ],
      }),
    ],
  });

  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot,
    bootstrapStatus: null,
    loadingState: "ready",
    error: null,
    selectedProjectId: "project-1",
    selectedEnvironmentId: "env-1",
    selectedThreadId: null,
  }));

  useTerminalStore.setState({
    knownEnvironmentIds: ["env-1", "env-2"],
    byEnv: {
      "env-1": {
        tabs: [makeTerminalTab("t1", "pty-1", "env-1")],
        activeTabId: "t1",
        visible: true,
        height: 280,
      },
      "env-2": {
        tabs: [],
        activeTabId: null,
        visible: false,
        height: 280,
      },
    },
  });
});

describe("StudioMain", () => {
  it("wraps the default workspace overview in the canonical pane scroll container", () => {
    const { container } = render(
      <StudioMain
        theme="dark"
        projectsSidebarOpen={false}
        inspectorOpen={false}
        composerFocusKey={0}
        approveOrSubmitKey={0}
        onToggleProjectsSidebar={() => {}}
        onToggleInspector={() => {}}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Workspace" }),
    ).toBeInTheDocument();
    expect(container.querySelector(".studio-main__pane-scroll")).not.toBeNull();
  });

  it("falls back to the workspace overview when a selected environment has no active thread", () => {
    act(() => {
      useWorkspaceStore.getState().selectEnvironment("env-1");
    });

    render(
      <StudioMain
        theme="dark"
        projectsSidebarOpen={false}
        inspectorOpen={false}
        composerFocusKey={0}
        approveOrSubmitKey={0}
        onToggleProjectsSidebar={() => {}}
        onToggleInspector={() => {}}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Workspace" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Start a new thread to begin working"),
    ).toBeNull();
  });

  it("keeps TerminalPanel mounted when another environment still has tabs", () => {
    const { container } = render(
      <StudioMain
        theme="dark"
        projectsSidebarOpen={false}
        inspectorOpen={false}
        composerFocusKey={0}
        approveOrSubmitKey={0}
        onToggleProjectsSidebar={() => {}}
        onToggleInspector={() => {}}
      />,
    );

    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
    expect(container.querySelector(".studio-main__terminal--hidden")).toBeNull();

    act(() => {
      useWorkspaceStore.setState({
        selectedEnvironmentId: "env-2",
        selectedThreadId: null,
      });
    });

    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
    expect(container.querySelector(".studio-main__terminal--hidden")).not.toBeNull();
  });
});
