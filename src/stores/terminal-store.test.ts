import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_HEIGHT_PX,
  MIN_TERMINAL_HEIGHT_PX,
  selectEnvironmentTerminalUi,
  useTerminalStore,
} from "./terminal-store";

describe("terminal-store", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      environments: {},
    });
  });

  it("creates the first terminal and opens the panel on demand", () => {
    const terminalId = useTerminalStore.getState().ensurePanel("env-1");
    const state = selectEnvironmentTerminalUi("env-1")(useTerminalStore.getState());

    expect(terminalId).toBeTruthy();
    expect(state.open).toBe(true);
    expect(state.heightPx).toBe(DEFAULT_TERMINAL_HEIGHT_PX);
    expect(state.tabs).toEqual([{ id: terminalId, title: "Terminal 1" }]);
    expect(state.activeTerminalId).toBe(terminalId);
  });

  it("creates sequentially numbered terminals and renumbers after close", () => {
    const first = useTerminalStore.getState().ensurePanel("env-1");
    const second = useTerminalStore.getState().createTerminal("env-1");
    const third = useTerminalStore.getState().createTerminal("env-1");

    useTerminalStore.getState().closeTerminal("env-1", second);

    const state = selectEnvironmentTerminalUi("env-1")(useTerminalStore.getState());
    expect(state.tabs).toEqual([
      { id: first, title: "Terminal 1" },
      { id: third, title: "Terminal 2" },
    ]);
    expect(state.activeTerminalId).toBe(third);
  });

  it("closes the panel when the last terminal is removed", () => {
    const first = useTerminalStore.getState().ensurePanel("env-1");

    useTerminalStore.getState().closeTerminal("env-1", first);

    const state = selectEnvironmentTerminalUi("env-1")(useTerminalStore.getState());
    expect(state.open).toBe(false);
    expect(state.tabs).toEqual([]);
    expect(state.activeTerminalId).toBeNull();
  });

  it("clamps terminal height and prunes removed environments", () => {
    useTerminalStore.getState().ensurePanel("env-1");
    useTerminalStore.getState().ensurePanel("env-2");
    useTerminalStore.getState().setHeight("env-1", 80);
    useTerminalStore.getState().pruneEnvironments(["env-1"]);

    const state = selectEnvironmentTerminalUi("env-1")(useTerminalStore.getState());
    expect(state.heightPx).toBe(MIN_TERMINAL_HEIGHT_PX);
    expect(useTerminalStore.getState().environments["env-2"]).toBeUndefined();
  });
});
