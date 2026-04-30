import { beforeEach, describe, expect, it } from "vitest";

import {
  SIDEBAR_WIDTH_STORAGE_KEY,
  SIDE_PANEL_WIDTH_STORAGE_KEY,
} from "../lib/app-identity";
import {
  SIDEBAR_PANEL_DEFAULT_WIDTH,
  SIDEBAR_PANEL_MAX_WIDTH,
  SIDEBAR_PANEL_MIN_WIDTH,
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  clampSidebarPanelWidth,
  clampSidePanelWidth,
  useSidePanelStore,
} from "./side-panel-store";

const storageState = new Map<string, string>();

beforeEach(() => {
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
  useSidePanelStore.setState({
    width: SIDE_PANEL_DEFAULT_WIDTH,
    sidebarWidth: SIDEBAR_PANEL_DEFAULT_WIDTH,
  });
});

describe("clampSidePanelWidth", () => {
  it("keeps values within bounds", () => {
    expect(clampSidePanelWidth(500)).toBe(500);
  });

  it("clamps below min", () => {
    expect(clampSidePanelWidth(100)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("clamps above max", () => {
    expect(clampSidePanelWidth(5000)).toBe(SIDE_PANEL_MAX_WIDTH);
  });

  it("rounds fractional widths", () => {
    expect(clampSidePanelWidth(420.7)).toBe(421);
  });

  it("returns default for NaN", () => {
    expect(clampSidePanelWidth(Number.NaN)).toBe(SIDE_PANEL_DEFAULT_WIDTH);
  });
});

describe("clampSidebarPanelWidth", () => {
  it("keeps values within bounds", () => {
    expect(clampSidebarPanelWidth(300)).toBe(300);
  });

  it("clamps below min", () => {
    expect(clampSidebarPanelWidth(100)).toBe(SIDEBAR_PANEL_MIN_WIDTH);
  });

  it("clamps above max", () => {
    expect(clampSidebarPanelWidth(999)).toBe(SIDEBAR_PANEL_MAX_WIDTH);
  });

  it("rounds fractional widths", () => {
    expect(clampSidebarPanelWidth(300.7)).toBe(301);
  });

  it("returns default for NaN", () => {
    expect(clampSidebarPanelWidth(Number.NaN)).toBe(SIDEBAR_PANEL_DEFAULT_WIDTH);
  });
});

describe("useSidePanelStore", () => {
  it("setWidth persists to localStorage after debounce", async () => {
    useSidePanelStore.getState().setWidth(600);
    expect(useSidePanelStore.getState().width).toBe(600);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(storageState.get(SIDE_PANEL_WIDTH_STORAGE_KEY)).toBe("600");
  });

  it("setWidth clamps to min", () => {
    useSidePanelStore.getState().setWidth(10);
    expect(useSidePanelStore.getState().width).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("setWidth clamps to max", () => {
    useSidePanelStore.getState().setWidth(9999);
    expect(useSidePanelStore.getState().width).toBe(SIDE_PANEL_MAX_WIDTH);
  });

  it("setWidth is a no-op when unchanged", () => {
    useSidePanelStore.getState().setWidth(500);
    const first = useSidePanelStore.getState();
    useSidePanelStore.getState().setWidth(500);
    const second = useSidePanelStore.getState();
    expect(first.width).toBe(second.width);
  });

  it("setSidebarWidth persists to localStorage after debounce", async () => {
    useSidePanelStore.getState().setSidebarWidth(320);
    expect(useSidePanelStore.getState().sidebarWidth).toBe(320);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(storageState.get(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("320");
  });

  it("setSidebarWidth clamps to min", () => {
    useSidePanelStore.getState().setSidebarWidth(10);
    expect(useSidePanelStore.getState().sidebarWidth).toBe(SIDEBAR_PANEL_MIN_WIDTH);
  });

  it("setSidebarWidth clamps to max", () => {
    useSidePanelStore.getState().setSidebarWidth(9999);
    expect(useSidePanelStore.getState().sidebarWidth).toBe(SIDEBAR_PANEL_MAX_WIDTH);
  });

  it("setSidebarWidth is a no-op when unchanged", () => {
    useSidePanelStore.getState().setSidebarWidth(300);
    const first = useSidePanelStore.getState();
    useSidePanelStore.getState().setSidebarWidth(300);
    const second = useSidePanelStore.getState();
    expect(first.sidebarWidth).toBe(second.sidebarWidth);
  });
});
