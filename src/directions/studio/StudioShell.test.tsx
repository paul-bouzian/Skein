import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceSnapshot } from "../../test/fixtures/conversation";
import { useCodexUsageStore } from "../../stores/codex-usage-store";
import { useGitReviewStore } from "../../stores/git-review-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { StudioShell } from "./StudioShell";

const storageState = new Map<string, string>();

vi.mock("./StudioMain", () => ({
  StudioMain: () => <div data-testid="studio-main" />,
}));

vi.mock("./InspectorPanel", () => ({
  InspectorPanel: () => <div data-testid="inspector-panel" />,
}));

vi.mock("./GitDiffPanel", () => ({
  GitDiffPanel: () => <div data-testid="git-diff-panel" />,
}));

vi.mock("./AppUpdateNotice", () => ({
  AppUpdateNotice: () => null,
}));

vi.mock("./StudioStatusBar", () => ({
  StudioStatusBar: () => (
    <div className="studio-statusbar" data-testid="studio-statusbar" />
  ),
}));

vi.mock("./SidebarUsagePanel", () => ({
  SidebarUsagePanel: () => <div data-testid="sidebar-usage-panel" />,
}));

vi.mock("./useProjectImport", () => ({
  useProjectImport: () => ({
    error: null,
    clearError: vi.fn(),
    importProject: vi.fn(),
    isImporting: false,
  }),
}));

vi.mock("../../shared/ProjectIcon", () => ({
  ProjectIcon: ({ name }: { name: string }) => <span>{name.slice(0, 1)}</span>,
}));

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
  document.documentElement.removeAttribute("data-theme");

  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: makeWorkspaceSnapshot(),
    bootstrapStatus: null,
    loadingState: "ready",
    error: null,
    selectedProjectId: "project-1",
    selectedEnvironmentId: "env-1",
    selectedThreadId: "thread-1",
    refreshSnapshot: vi.fn(async () => {}),
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
  useGitReviewStore.setState((state) => ({
    ...state,
    scopeByEnvironmentId: {},
    snapshotsByContext: {},
    selectedFileByContext: {},
    diffsByContext: {},
    diffErrorByContext: {},
    commitMessageByEnvironmentId: {},
    loadingByContext: {},
    reviewRequestIdByContext: {},
    diffLoadingByContext: {},
    diffRequestIdByContext: {},
    actionByEnvironmentId: {},
    generatingCommitMessageByEnvironmentId: {},
    errorByContext: {},
  }));
});

describe("StudioShell", () => {
  it("opens the settings dialog from the sidebar and closes it with all supported interactions", async () => {
    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Codex binary")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Close settings" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const backdrop = document.querySelector(".settings-dialog__backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("toggles theme from the sidebar footer and persists the selected theme", async () => {
    render(<StudioShell />);

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
    expect(localStorage.getItem("threadex-theme")).toBe("dark");

    await userEvent.click(screen.getByRole("button", { name: "Light mode" }));

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
    expect(localStorage.getItem("threadex-theme")).toBe("light");
    expect(
      screen.getByRole("button", { name: "Dark mode" }),
    ).toBeInTheDocument();
  });

  it("renders settings picker menus above the modal backdrop", async () => {
    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Default model picker" }),
    );

    const menu = screen.getByRole("listbox", {
      name: "Default model options",
    });
    expect(menu).toBeInTheDocument();
    expect(menu).toHaveStyle({ zIndex: "1310" });
  });
});
