import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalStore } from "../../stores/terminal-store";
import { EnvironmentActionControl } from "./EnvironmentActionControl";


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
    const onAddAction = vi.fn();
    useTerminalStore.setState({ openActionTab });

    render(
      <EnvironmentActionControl
        environmentId="env-1"
        projectId="project-1"
        onAddAction={onAddAction}
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
    expect(onAddAction).not.toHaveBeenCalled();
  });

  it("launches the chosen menu action and remembers it as the next primary action", async () => {
    const user = userEvent.setup();
    const openActionTab = vi.fn(async () => "tab-2");
    const onAddAction = vi.fn();
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
        onAddAction={onAddAction}
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
        onAddAction={onAddAction}
      />,
    );

    expect(screen.getByRole("button", { name: "Run Stop" })).toBeInTheDocument();
    expect(onAddAction).not.toHaveBeenCalled();
  });

  it("shows the control without actions and routes both entry points to add action", async () => {
    const user = userEvent.setup();
    const onAddAction = vi.fn();

    render(
      <EnvironmentActionControl
        environmentId="env-1"
        projectId="project-1"
        actions={[]}
        onAddAction={onAddAction}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add project action" }));
    expect(onAddAction).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Project action options" }));
    expect(screen.getByRole("menuitem", { name: /Add action/i })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: /Add action/i }));
    expect(onAddAction).toHaveBeenCalledTimes(2);
  });

  it("offers add action alongside existing actions in the menu", async () => {
    const user = userEvent.setup();
    const onAddAction = vi.fn();

    render(
      <EnvironmentActionControl
        environmentId="env-1"
        projectId="project-1"
        onAddAction={onAddAction}
        actions={[
          {
            id: "dev",
            label: "Dev",
            icon: "play",
            script: "bun run dev",
            shortcut: null,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose project action" }));
    await user.click(screen.getByRole("menuitem", { name: /Add action/i }));

    expect(onAddAction).toHaveBeenCalledTimes(1);
  });
});
