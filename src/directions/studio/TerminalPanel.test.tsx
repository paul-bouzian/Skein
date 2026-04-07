import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import { useTerminalStore } from "../../stores/terminal-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { TerminalPanel } from "./TerminalPanel";

vi.mock("./TerminalView", () => ({
  TerminalView: ({ ptyId, active }: { ptyId: string; active: boolean }) => (
    <div data-testid={`terminal-view-${ptyId}`} data-active={active} />
  ),
}));

vi.mock("../../lib/bridge", () => ({
  spawnTerminal: vi.fn(),
  killTerminal: vi.fn().mockResolvedValue(undefined),
  listenToTerminalExit: vi.fn().mockResolvedValue(() => {}),
}));

const mockedBridge = vi.mocked(bridge);

const storageState = new Map<string, string>();

beforeEach(() => {
  vi.clearAllMocks();
  storageState.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storageState.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageState.set(key, String(value));
      },
      removeItem: (key: string) => {
        storageState.delete(key);
      },
      clear: () => {
        storageState.clear();
      },
    },
  });

  let counter = 0;
  mockedBridge.spawnTerminal.mockImplementation(async () => {
    counter += 1;
    return { ptyId: `pty-${counter}` };
  });

  // Reset workspace store so cwd resolution falls back to "".
  useWorkspaceStore.setState({
    snapshot: null,
    bootstrapStatus: null,
    loadingState: "idle",
    error: null,
    selectedProjectId: null,
    selectedEnvironmentId: null,
    selectedThreadId: null,
  });

  // Seed terminal store with two tabs to bypass auto-bootstrap.
  useTerminalStore.setState({
    visible: true,
    height: 280,
    tabs: [
      { id: "t1", ptyId: "pty-existing-1", cwd: "/p/a", title: "a", exited: false },
      { id: "t2", ptyId: "pty-existing-2", cwd: "/p/b", title: "b", exited: false },
    ],
    activeTabId: "t1",
  });
});

describe("TerminalPanel", () => {
  it("renders one terminal view per tab", () => {
    render(<TerminalPanel />);
    expect(screen.getByTestId("terminal-view-pty-existing-1")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-view-pty-existing-2")).toBeInTheDocument();
  });

  it("opens a new terminal when the + button is clicked", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.click(screen.getByTitle("New terminal"));

    await waitFor(() => {
      expect(mockedBridge.spawnTerminal).toHaveBeenCalledTimes(1);
    });
    expect(useTerminalStore.getState().tabs).toHaveLength(3);
  });

  it("closes a tab via the per-tab close button", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);

    const closeButtons = screen.getAllByLabelText("Close terminal");
    await user.click(closeButtons[0]);

    await waitFor(() => {
      expect(useTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(mockedBridge.killTerminal).toHaveBeenCalledWith({
      ptyId: "pty-existing-1",
    });
  });

  it("hides the panel when the hide button is clicked", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.click(screen.getByTitle("Hide terminal"));
    expect(useTerminalStore.getState().visible).toBe(false);
  });

  it("activates a tab when its title is clicked", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.click(screen.getByText("b"));
    expect(useTerminalStore.getState().activeTabId).toBe("t2");
  });
});
