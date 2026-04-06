import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import { makeWorkspaceSnapshot } from "../../test/fixtures/conversation";
import { useTerminalStore } from "../../stores/terminal-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { StudioMain } from "./StudioMain";

vi.mock("../../lib/bridge", () => ({
  closeEnvironmentTerminal: vi.fn().mockResolvedValue(undefined),
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

vi.mock("./terminal/TerminalDock", () => ({
  TerminalDock: ({
    tabs,
    activeTerminalId,
  }: {
    tabs: Array<{ id: string; title: string }>;
    activeTerminalId: string | null;
  }) => (
    <div data-testid="terminal-dock">
      {tabs.map((tab) => (
        <span key={tab.id}>
          {tab.title}:{tab.id === activeTerminalId ? "active" : "idle"}
        </span>
      ))}
    </div>
  ),
}));

const mockedBridge = vi.mocked(bridge);

describe("StudioMain", () => {
  beforeEach(() => {
    mockedBridge.closeEnvironmentTerminal.mockClear();
    useTerminalStore.setState({ environments: {} });
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot(),
      loadingState: "ready",
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
      selectedThreadId: "thread-1",
    }));
  });

  it("renders a terminal toggle and creates the first terminal tab when opened", async () => {
    render(<StudioMain inspectorOpen onToggleInspector={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Show terminal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide inspector" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show terminal" }));

    expect(screen.getByTestId("terminal-dock")).toBeInTheDocument();
    expect(screen.getByText(/Terminal 1:active/i)).toBeInTheDocument();
  });

  it("hides the terminal toggle when no environment is selected", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      selectedEnvironmentId: null,
      selectedThreadId: null,
    }));

    render(<StudioMain inspectorOpen={false} onToggleInspector={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /terminal/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Show inspector" })).toBeInTheDocument();
  });
});
