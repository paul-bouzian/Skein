import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalStore } from "../../stores/terminal-store";
import { EnvironmentActionControl } from "./EnvironmentActionControl";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: vi.fn(),
}));

const storageState = new Map<string, string>();

describe("EnvironmentActionControl", () => {
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
    useTerminalStore.setState(useTerminalStore.getInitialState(), true);
  });

  it("runs the primary action from the main button", async () => {
    const user = userEvent.setup();
    const openActionTab = vi.fn(async () => "tab-1");
    useTerminalStore.setState({ openActionTab });

    render(
      <EnvironmentActionControl
        environmentId="env-1"
        projectId="project-1"
        actions={[
          {
            id: "dev",
            label: "Dev",
            icon: "play",
            script: "bun run dev",
            shortcut: "mod+shift+d",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Run Dev" }));

    expect(openActionTab).toHaveBeenCalledWith("env-1", {
      id: "dev",
      label: "Dev",
      icon: "play",
      script: "bun run dev",
      shortcut: "mod+shift+d",
    });
  });

  it("launches the chosen menu action and remembers it as the next primary action", async () => {
    const user = userEvent.setup();
    const openActionTab = vi.fn(async () => "tab-2");
    useTerminalStore.setState({ openActionTab });
    const actions = [
      {
        id: "dev",
        label: "Dev",
        icon: "play" as const,
        script: "bun run dev",
        shortcut: "mod+shift+d",
      },
      {
        id: "stop",
        label: "Stop",
        icon: "debug" as const,
        script: "pkill -f vite",
        shortcut: "mod+shift+s",
      },
    ];
    const { rerender } = render(
      <EnvironmentActionControl
        environmentId="env-1"
        projectId="project-1"
        actions={actions}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose project action" }));
    await user.click(screen.getByRole("menuitem", { name: /Stop/ }));

    expect(openActionTab).toHaveBeenCalledWith("env-1", actions[1]);
    await waitFor(() => {
      expect(localStorage.getItem("skein-preferred-project-actions")).toContain("stop");
    });

    rerender(
      <EnvironmentActionControl
        environmentId="env-1"
        projectId="project-1"
        actions={[...actions]}
      />,
    );

    expect(screen.getByRole("button", { name: "Run Stop" })).toBeInTheDocument();
  });
});
