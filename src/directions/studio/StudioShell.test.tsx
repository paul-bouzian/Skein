import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as bridge from "../../lib/bridge";
import { isMacPlatform } from "../../lib/shortcuts";
import {
  baseComposer,
  capabilitiesFixture,
  makeConversationSnapshot,
  makeGlobalSettings,
  makeProject,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { useCodexUsageStore } from "../../stores/codex-usage-store";
import { useConversationStore } from "../../stores/conversation-store";
import { useFirstPromptRenameStore } from "../../stores/first-prompt-rename-store";
import { useGitReviewStore } from "../../stores/git-review-store";
import { useTerminalStore } from "../../stores/terminal-store";
import {
  resetVoiceSessionStore,
  useVoiceSessionStore,
} from "../../stores/voice-session-store";
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

vi.mock("../../lib/bridge", () => ({
  getShortcutDefaults: vi.fn(),
  updateGlobalSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
  listenToMenuOpenSettings: vi.fn(async () => () => undefined),
}));

const mockedBridge = vi.mocked(bridge);

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  storageState.clear();
  await resetVoiceSessionStore();
  mockedBridge.updateGlobalSettings.mockReset();
  mockedBridge.updateProjectSettings.mockReset();
  mockedBridge.listenToMenuOpenSettings.mockReset();
  mockedBridge.getShortcutDefaults?.mockReset();
  mockedBridge.getShortcutDefaults?.mockResolvedValue(makeGlobalSettings().shortcuts);
  mockedBridge.updateGlobalSettings.mockResolvedValue(makeGlobalSettings());
  mockedBridge.updateProjectSettings.mockResolvedValue(makeWorkspaceSnapshot().projects[0]);
  mockedBridge.listenToMenuOpenSettings.mockResolvedValue(() => undefined);
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
    refreshSnapshot: vi.fn(async () => true),
  }));
  useConversationStore.setState((state) => ({
    ...state,
    snapshotsByThreadId: {},
    capabilitiesByEnvironmentId: {},
    composerByThreadId: {},
    loadingByThreadId: {},
    errorByThreadId: {},
    listenerReady: false,
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
  useFirstPromptRenameStore.setState((state) => ({
    ...state,
    latestFailure: null,
    listenerReady: false,
  }));
  useTerminalStore.setState({
    visible: false,
    height: 280,
    byEnv: {},
    knownEnvironmentIds: [],
  });
});

describe("StudioShell", () => {
  const primaryModifier = () => (isMacPlatform() ? { metaKey: true } : { ctrlKey: true });

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

  it("opens the settings dialog from the macOS menu event", async () => {
    let callback: (() => void) | null = null;
    mockedBridge.listenToMenuOpenSettings.mockImplementation(async (next) => {
      callback = next;
      return () => undefined;
    });

    render(<StudioShell />);

    await waitFor(() => {
      expect(mockedBridge.listenToMenuOpenSettings).toHaveBeenCalledTimes(1);
    });

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await act(async () => {
      callback?.();
    });

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  });

  it("opens settings from the global keyboard shortcut", async () => {
    render(<StudioShell />);

    fireEvent.keyDown(window, {
      key: ",",
      ...primaryModifier(),
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  it("toggles the terminal with the global shortcut and disables app shortcuts while settings are open", async () => {
    render(<StudioShell />);

    fireEvent.keyDown(window, {
      key: "j",
      ...primaryModifier(),
    });

    await waitFor(() => {
      expect(useTerminalStore.getState().visible).toBe(true);
    });

    fireEvent.keyDown(window, {
      key: "j",
      ...primaryModifier(),
    });

    await waitFor(() => {
      expect(useTerminalStore.getState().visible).toBe(false);
    });

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    fireEvent.keyDown(window, {
      key: "j",
      ...primaryModifier(),
    });

    expect(useTerminalStore.getState().visible).toBe(false);
  });

  it("prevents native Shift+Tab navigation even when mode cycling has no next value", () => {
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: {
        "thread-1": makeConversationSnapshot(),
      },
      composerByThreadId: {
        "thread-1": baseComposer,
      },
      capabilitiesByEnvironmentId: {
        "env-1": {
          ...capabilitiesFixture,
          collaborationModes: [{ id: "build", label: "Build", mode: "build" }],
        },
      },
    }));

    render(<StudioShell />);

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("toggles theme from the sidebar footer and persists the selected theme", async () => {
    render(<StudioShell />);

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
    expect(localStorage.getItem("loom-theme")).toBe("dark");

    await userEvent.click(screen.getByRole("button", { name: "Light mode" }));

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
    expect(localStorage.getItem("loom-theme")).toBe("light");
    expect(
      screen.getByRole("button", { name: "Dark mode" }),
    ).toBeInTheDocument();
  });

  it("migrates the legacy theme key into the Loom namespace", async () => {
    storageState.set("threadex-theme", "light");

    render(<StudioShell />);

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
    expect(localStorage.getItem("loom-theme")).toBe("light");
    expect(localStorage.getItem("threadex-theme")).toBeNull();
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

  it("reconciles and clears voice state when the owner thread disappears from the workspace snapshot", async () => {
    render(<StudioShell />);

    useVoiceSessionStore.setState((state) => ({
      ...state,
      durationMs: 4_000,
      ownerEnvironmentId: "env-1",
      ownerThreadId: "thread-1",
      phase: "recording",
    }));

    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [
              {
                ...state.snapshot!.projects[0]!.environments[0]!,
                threads: [],
              },
            ],
          }),
        ],
      }),
    }));

    await waitFor(() => {
      expect(useVoiceSessionStore.getState()).toMatchObject({
        ownerEnvironmentId: null,
        ownerThreadId: null,
        phase: "idle",
      });
    });
  });

  it("closes an open settings picker before dismissing the modal on Escape", async () => {
    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Default model picker" }),
    );
    expect(
      screen.getByRole("listbox", { name: "Default model options" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(
        screen.queryByRole("listbox", { name: "Default model options" }),
      ).toBeNull();
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("saves the Codex binary path only once on blur", async () => {
    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const input = screen.getByPlaceholderText("auto-detect");
    await userEvent.clear(input);
    await userEvent.type(input, "/usr/local/bin/codex");

    expect(mockedBridge.updateGlobalSettings).not.toHaveBeenCalled();

    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledTimes(1);
    });
    expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledWith({
      codexBinaryPath: "/usr/local/bin/codex",
    });
  });

  it("shows an error when settings save succeeds but the workspace refresh fails", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      refreshSnapshot: vi.fn(async () => false),
    }));

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Default approval picker" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Full access" }));

    expect(
      await screen.findByText(
        "Settings were saved, but the workspace snapshot could not be refreshed.",
      ),
    ).toBeInTheDocument();
  });

  it("saves the default speed mode from Codex settings", async () => {
    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Default speed picker" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Fast" }));

    await waitFor(() => {
      expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledWith({
        defaultServiceTier: "fast",
      });
    });
  });

  it("saves Normal speed as the backend flex tier", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        settings: makeGlobalSettings({
          defaultServiceTier: "fast",
        }),
      }),
    }));

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Default speed picker" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Normal" }));

    await waitFor(() => {
      expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledWith({
        defaultServiceTier: "flex",
      });
    });
  });

  it("saves the compact work activity setting from Codex settings", async () => {
    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(
      screen.getByRole("switch", { name: "Collapse work activity" }),
    );

    await waitFor(() => {
      expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledWith({
        collapseWorkActivity: false,
      });
    });
  });

  it("ignores repeated compact-toggle clicks while the settings save is in flight", async () => {
    const saveRequest =
      createDeferred<ReturnType<typeof makeWorkspaceSnapshot>["settings"]>();
    mockedBridge.updateGlobalSettings.mockImplementation(() => saveRequest.promise);

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const toggle = screen.getByRole("switch", { name: "Collapse work activity" });

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toBeDisabled();
    });
    expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledTimes(1);

    await userEvent.click(toggle);
    expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledTimes(1);

    saveRequest.resolve(makeWorkspaceSnapshot().settings);

    await waitFor(() => {
      expect(toggle).not.toBeDisabled();
    });
  });

  it("disables update controls while a global settings save is in flight", async () => {
    const saveRequest =
      createDeferred<ReturnType<typeof makeWorkspaceSnapshot>["settings"]>();
    mockedBridge.updateGlobalSettings.mockImplementation(() => saveRequest.promise);

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const toggle = screen.getByRole("switch", { name: "Collapse work activity" });
    const checkForUpdates = screen.getByRole("button", {
      name: "Check for updates",
    });

    expect(checkForUpdates).not.toBeDisabled();

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toBeDisabled();
      expect(checkForUpdates).toBeDisabled();
    });

    saveRequest.resolve(makeWorkspaceSnapshot().settings);

    await waitFor(() => {
      expect(checkForUpdates).not.toBeDisabled();
    });
  });

  it("reuses Codex model ids in settings when runtime capabilities are available", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        settings: {
          ...makeWorkspaceSnapshot().settings,
          defaultModel: "gpt-5.4-mini",
        },
      }),
    }));
    useConversationStore.setState((state) => ({
      ...state,
      capabilitiesByEnvironmentId: {
        "env-1": {
          environmentId: "env-1",
          models: [
            {
              id: "gpt-5.4-mini",
              displayName: "GPT-5.4-mini",
              description: "Mini Codex model",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["low", "medium", "high"],
              inputModalities: ["text", "image"],
              isDefault: true,
            },
          ],
          collaborationModes: [],
        },
      },
    }));

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const modelPicker = screen.getByRole("button", {
      name: "Default model picker",
    });
    expect(modelPicker).toHaveTextContent("gpt-5.4-mini");

    await userEvent.click(modelPicker);

    expect(
      screen.getByRole("option", { name: "gpt-5.4-mini" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "GPT-5.4-mini" }),
    ).toBeNull();
  });

  it("saves per-project worktree scripts from the Project settings tab", async () => {
    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Project" }));

    const setupInput = screen.getByLabelText("Setup Script");
    const teardownInput = screen.getByLabelText("Teardown Script");

    await userEvent.type(setupInput, "pnpm install");
    await userEvent.type(teardownInput, "./scripts/cleanup.sh");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockedBridge.updateProjectSettings).toHaveBeenCalledWith({
        projectId: "project-1",
        patch: {
          worktreeSetupScript: "pnpm install",
          worktreeTeardownScript: "./scripts/cleanup.sh",
        },
      });
    });
  });

  it("keeps project script saves successful when only the refresh fails", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      refreshSnapshot: vi.fn(async () => false),
    }));

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Project" }));

    const setupInput = screen.getByLabelText("Setup Script");
    await userEvent.type(setupInput, "pnpm install");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "Settings were saved, but the workspace snapshot could not be refreshed.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });
  });

  it("preserves the user's expanded project card across snapshot refreshes", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({ id: "project-1", name: "Loom" }),
          makeProject({
            id: "project-2",
            name: "Sandbox",
            rootPath: "/tmp/sandbox",
          }),
        ],
      }),
      selectedProjectId: "project-1",
    }));

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Project" }));

    const dialog = screen.getByRole("dialog");
    const sandboxHeader = within(dialog).getByRole("button", { name: /Sandbox/i });
    await userEvent.click(sandboxHeader);
    expect(sandboxHeader).toHaveAttribute("aria-expanded", "true");

    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({ id: "project-1", name: "Loom" }),
          makeProject({
            id: "project-2",
            name: "Sandbox",
            rootPath: "/tmp/sandbox",
          }),
        ],
      }),
      selectedProjectId: "project-1",
    }));

    await waitFor(() => {
      expect(
        within(screen.getByRole("dialog")).getByRole("button", { name: /Sandbox/i }),
      ).toHaveAttribute("aria-expanded", "true");
    });
  });
});
