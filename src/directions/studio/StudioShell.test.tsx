import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as notifications from "@tauri-apps/plugin-notification";

import * as bridge from "../../lib/bridge";
import { isMacPlatform } from "../../lib/shortcuts";
import {
  baseComposer,
  capabilitiesFixture,
  makeConversationSnapshot,
  makeEnvironment,
  makeGlobalSettings,
  makeProject,
  makeThread,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { useCodexUsageStore } from "../../stores/codex-usage-store";
import { useConversationStore } from "../../stores/conversation-store";
import { useFirstPromptRenameStore } from "../../stores/first-prompt-rename-store";
import { useGitReviewStore } from "../../stores/git-review-store";
import { selectTerminalSlot, useTerminalStore } from "../../stores/terminal-store";
import {
  resetVoiceSessionStore,
  useVoiceSessionStore,
} from "../../stores/voice-session-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { StudioShell } from "./StudioShell";

const storageState = new Map<string, string>();

vi.mock("./StudioMain", () => ({
  StudioMain: ({
    onOpenActionCreateDialog,
    inspectorOpen,
    browserOpen,
    onToggleInspector,
    onToggleBrowser,
  }: {
    onOpenActionCreateDialog: () => void;
    inspectorOpen: boolean;
    browserOpen: boolean;
    onToggleInspector: () => void;
    onToggleBrowser: () => void;
  }) => (
     <div data-testid="studio-main">
      <button type="button" onClick={onOpenActionCreateDialog}>
        Open action dialog
      </button>
       <button type="button" onClick={onToggleInspector}>
         {inspectorOpen ? "Hide inspector" : "Show inspector"}
       </button>
       <button type="button" onClick={onToggleBrowser}>
         {browserOpen ? "Hide browser" : "Show browser"}
       </button>
     </div>
   ),
}));

vi.mock("./InspectorPanel", () => ({
  InspectorPanel: ({ collapsed = false }: { collapsed?: boolean }) => (
    <div data-testid="inspector-panel" data-collapsed={String(collapsed)} />
  ),
}));

vi.mock("./BrowserPanel", () => ({
  BrowserPanel: ({ collapsed = false }: { collapsed?: boolean }) => (
    <div data-testid="browser-panel" data-collapsed={String(collapsed)} />
  ),
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
  getEnvironmentCapabilities: vi.fn(),
  getShortcutDefaults: vi.fn(),
  updateGlobalSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
  listenToMenuOpenSettings: vi.fn(async () => () => undefined),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: vi.fn(),
}));

const mockedBridge = vi.mocked(bridge);
const mockedNotifications = vi.mocked(notifications);

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
  mockedBridge.getEnvironmentCapabilities.mockResolvedValue(capabilitiesFixture);
  mockedBridge.updateGlobalSettings.mockReset();
  mockedBridge.updateProjectSettings.mockReset();
  mockedBridge.listenToMenuOpenSettings.mockReset();
  mockedBridge.getShortcutDefaults?.mockReset();
  mockedBridge.getShortcutDefaults?.mockResolvedValue(makeGlobalSettings().shortcuts);
  mockedBridge.updateGlobalSettings.mockResolvedValue(makeGlobalSettings());
  mockedBridge.updateProjectSettings.mockResolvedValue(makeWorkspaceSnapshot().projects[0]);
  mockedBridge.listenToMenuOpenSettings.mockResolvedValue(() => undefined);
  mockedNotifications.isPermissionGranted.mockReset();
  mockedNotifications.requestPermission.mockReset();
  mockedNotifications.isPermissionGranted.mockResolvedValue(true);
  mockedNotifications.requestPermission.mockResolvedValue("granted");
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
    hydrationByThreadId: {},
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

  it("closes the action dialog before opening settings from the menu event", async () => {
    let callback: (() => void) | null = null;
    mockedBridge.listenToMenuOpenSettings.mockImplementation(async (next) => {
      callback = next;
      return () => undefined;
    });

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Open action dialog" }));
    expect(screen.getByRole("dialog", { name: "Add Action" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");

    await act(async () => {
      callback?.();
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("dialog", { name: "Add Action" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    });
    expect(document.body.style.overflow).toBe("");
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

  it("starts with the review panel closed and opens it from the toolbar toggle", async () => {
    render(<StudioShell />);

    expect(screen.getByTestId("inspector-panel")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Show inspector" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show inspector" }));

    await waitFor(() => {
      expect(screen.getByTestId("inspector-panel")).toHaveAttribute(
        "data-collapsed",
        "false",
      );
    });
    expect(screen.getByRole("button", { name: "Hide inspector" })).toBeInTheDocument();
  });

  it("toggles the review panel with the global shortcut", async () => {
    render(<StudioShell />);

    expect(screen.getByTestId("inspector-panel")).toHaveAttribute(
      "data-collapsed",
      "true",
    );

    fireEvent.keyDown(window, {
      key: "g",
      ...primaryModifier(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("inspector-panel")).toHaveAttribute(
        "data-collapsed",
        "false",
      );
    });

    fireEvent.keyDown(window, {
      key: "g",
      ...primaryModifier(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("inspector-panel")).toHaveAttribute(
        "data-collapsed",
        "true",
      );
    });
  });

  it("toggles the terminal with the global shortcut and disables app shortcuts while settings are open", async () => {
    render(<StudioShell />);

    fireEvent.keyDown(window, {
      key: "j",
      ...primaryModifier(),
    });

    await waitFor(() => {
      expect(selectTerminalSlot("env-1")(useTerminalStore.getState()).visible).toBe(true);
    });

    fireEvent.keyDown(window, {
      key: "j",
      ...primaryModifier(),
    });

    await waitFor(() => {
      expect(selectTerminalSlot("env-1")(useTerminalStore.getState()).visible).toBe(false);
    });

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    fireEvent.keyDown(window, {
      key: "j",
      ...primaryModifier(),
    });

    expect(selectTerminalSlot("env-1")(useTerminalStore.getState()).visible).toBe(false);
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

  it("toggles exclusively between inspector and browser panels", async () => {
    render(<StudioShell />);

    expect(screen.getByTestId("inspector-panel")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(screen.getByTestId("browser-panel")).toHaveAttribute(
      "data-collapsed",
      "true",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Show inspector" }),
    );
    expect(screen.getByTestId("inspector-panel")).toHaveAttribute(
      "data-collapsed",
      "false",
    );
    expect(screen.getByTestId("browser-panel")).toHaveAttribute(
      "data-collapsed",
      "true",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Show browser" }),
    );
    expect(screen.getByTestId("browser-panel")).toHaveAttribute(
      "data-collapsed",
      "false",
    );
    expect(screen.getByTestId("inspector-panel")).toHaveAttribute(
      "data-collapsed",
      "true",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Hide browser" }),
    );
    expect(screen.getByTestId("browser-panel")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(screen.getByTestId("inspector-panel")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
  });

  it("closes the inspector when switching to a chat thread", async () => {
    const chatThread = makeThread({
      id: "chat-thread-1",
      environmentId: "chat-env-1",
    });
    const chatEnvironment = makeEnvironment({
      id: "chat-env-1",
      projectId: "skein-chat-workspace",
      name: "Chat",
      kind: "chat",
      path: "/tmp/.skein/chats/chat-env-1",
      gitBranch: undefined,
      baseBranch: undefined,
      isDefault: false,
      pullRequest: undefined,
      threads: [chatThread],
      runtime: undefined,
    });
    const baseSnapshot = makeWorkspaceSnapshot();
    const projectEnvironment = baseSnapshot.projects[0]?.environments[0];
    const projectThread = projectEnvironment?.threads[0];

    expect(projectEnvironment).toBeDefined();
    expect(projectThread).toBeDefined();

    render(<StudioShell />);

    await userEvent.click(
      screen.getByRole("button", { name: "Show inspector" }),
    );
    expect(screen.getByTestId("inspector-panel")).toHaveAttribute(
      "data-collapsed",
      "false",
    );

    act(() => {
      useWorkspaceStore.setState((state) => ({
        ...state,
        snapshot: {
          ...baseSnapshot,
          chat: {
            ...baseSnapshot.chat,
            environments: [chatEnvironment],
          },
        },
        layout: {
          slots: {
            topLeft: null,
            topRight: null,
            bottomLeft: null,
            bottomRight: null,
          },
          focusedSlot: null,
          rowRatio: 0.5,
          colRatio: 0.5,
        },
        draftBySlot: {},
        selectedProjectId: "skein-chat-workspace",
        selectedEnvironmentId: chatEnvironment.id,
        selectedThreadId: chatThread.id,
      }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("inspector-panel")).toHaveAttribute(
        "data-collapsed",
        "true",
      );
    });

    act(() => {
      useWorkspaceStore.setState((state) => ({
        ...state,
        snapshot: baseSnapshot,
        selectedProjectId: projectEnvironment?.projectId ?? null,
        selectedEnvironmentId: projectEnvironment?.id ?? null,
        selectedThreadId: projectThread?.id ?? null,
      }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("inspector-panel")).toHaveAttribute(
        "data-collapsed",
        "true",
      );
    });
  });

  it("opens the git diff panel for project drafts using the effective review environment", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot(),
      layout: {
        slots: {
          topLeft: null,
          topRight: null,
          bottomLeft: null,
          bottomRight: null,
        },
        focusedSlot: null,
        rowRatio: 0.5,
        colRatio: 0.5,
      },
      draftBySlot: {},
      selectedProjectId: null,
      selectedEnvironmentId: null,
      selectedThreadId: null,
    }));
    useWorkspaceStore.getState().openThreadDraft("project-1");
    useGitReviewStore.setState((state) => ({
      ...state,
      selectedFileByContext: {
        "env-1:uncommitted": "modified:src/app.ts",
      },
    }));

    render(<StudioShell />);

    expect(useWorkspaceStore.getState().selectedEnvironmentId).toBeNull();
    expect(screen.getByTestId("git-diff-panel")).toBeInTheDocument();
  });

  it("toggles theme from the sidebar footer and persists the selected theme", async () => {
    render(<StudioShell />);

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
    expect(localStorage.getItem("skein-theme")).toBe("dark");

    await userEvent.click(screen.getByRole("button", { name: "Light mode" }));

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
    expect(localStorage.getItem("skein-theme")).toBe("light");
    expect(
      screen.getByRole("button", { name: "Dark mode" }),
    ).toBeInTheDocument();
  });

  it("migrates legacy theme keys into the Skein namespace", async () => {
    storageState.set("loom-theme", "light");
    storageState.set("threadex-theme", "dark");

    render(<StudioShell />);

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
    expect(localStorage.getItem("skein-theme")).toBe("light");
    expect(localStorage.getItem("loom-theme")).toBeNull();
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

  it("shows the assistant streaming copy in Codex settings", async () => {
    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByText("Stream assistant responses")).toBeInTheDocument();
    expect(
      screen.getByText("Stream assistant replies token by token in real time."),
    ).toBeInTheDocument();
  });

  it("saves the assistant streaming setting from Codex settings", async () => {
    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(
      screen.getByRole("switch", { name: "Stream assistant responses" }),
    );

    await waitFor(() => {
      expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledWith({
        streamAssistantResponses: false,
      });
    });
  });

  it("shows the desktop notifications copy in Notifications settings", async () => {
    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByText("Desktop notifications")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));

    expect(screen.getByText("Desktop notifications")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Show an OS notification when a chat finishes or needs input while the app is in the background.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Desktop app notifications use your operating system notification center.",
      ),
    ).toBeInTheDocument();
  });

  it("requests notification permission before enabling desktop notifications", async () => {
    mockedNotifications.isPermissionGranted.mockResolvedValue(false);
    mockedNotifications.requestPermission.mockResolvedValue("granted");
    mockedBridge.updateGlobalSettings.mockResolvedValue(
      makeGlobalSettings({ desktopNotificationsEnabled: true }),
    );

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await userEvent.click(
      screen.getByRole("switch", { name: "Desktop notifications" }),
    );

    await waitFor(() => {
      expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledWith({
        desktopNotificationsEnabled: true,
      });
    });
    expect(mockedNotifications.isPermissionGranted).toHaveBeenCalledTimes(1);
    expect(mockedNotifications.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("disables other global settings while desktop notification permission is pending", async () => {
    const permissionRequest = createDeferred<"granted" | "denied">();
    mockedNotifications.isPermissionGranted.mockResolvedValue(false);
    mockedNotifications.requestPermission.mockImplementation(
      () => permissionRequest.promise,
    );
    mockedBridge.updateGlobalSettings.mockResolvedValue(
      makeGlobalSettings({ desktopNotificationsEnabled: true }),
    );

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const desktopToggle = screen.getByRole("switch", {
      name: "Desktop notifications",
    });

    await userEvent.click(desktopToggle);

    await waitFor(() => {
      expect(desktopToggle).toBeDisabled();
    });
    expect(mockedBridge.updateGlobalSettings).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Codex" }));
    const collapseToggle = screen.getByRole("switch", {
      name: "Collapse work activity",
    });
    expect(collapseToggle).toBeDisabled();
    await userEvent.click(collapseToggle);
    expect(mockedBridge.updateGlobalSettings).not.toHaveBeenCalled();

    permissionRequest.resolve("granted");

    await waitFor(() => {
      expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledWith({
        desktopNotificationsEnabled: true,
      });
    });
    expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps desktop notifications off when notification permission is denied", async () => {
    mockedNotifications.isPermissionGranted.mockResolvedValue(false);
    mockedNotifications.requestPermission.mockResolvedValue("denied");

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const toggle = screen.getByRole("switch", { name: "Desktop notifications" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Desktop notifications were not enabled because permission was denied by the operating system.",
        ),
      ).toBeInTheDocument();
    });
    expect(mockedBridge.updateGlobalSettings).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("disables desktop notifications without requesting permission again", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        settings: makeGlobalSettings({ desktopNotificationsEnabled: true }),
      }),
    }));
    mockedBridge.updateGlobalSettings.mockResolvedValue(
      makeGlobalSettings({ desktopNotificationsEnabled: false }),
    );

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await userEvent.click(
      screen.getByRole("switch", { name: "Desktop notifications" }),
    );

    await waitFor(() => {
      expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledWith({
        desktopNotificationsEnabled: false,
      });
    });
    expect(mockedNotifications.requestPermission).not.toHaveBeenCalled();
  });

  it("ignores repeated desktop notification toggles while the save is in flight", async () => {
    const saveRequest =
      createDeferred<ReturnType<typeof makeWorkspaceSnapshot>["settings"]>();
    mockedNotifications.isPermissionGranted.mockResolvedValue(false);
    mockedNotifications.requestPermission.mockResolvedValue("granted");
    mockedBridge.updateGlobalSettings.mockImplementation(() => saveRequest.promise);

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const toggle = screen.getByRole("switch", { name: "Desktop notifications" });

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toBeDisabled();
    });
    expect(mockedNotifications.requestPermission).toHaveBeenCalledTimes(1);
    expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledTimes(1);

    await userEvent.click(toggle);

    expect(mockedNotifications.requestPermission).toHaveBeenCalledTimes(1);
    expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledTimes(1);

    saveRequest.resolve(makeWorkspaceSnapshot().settings);

    await waitFor(() => {
      expect(toggle).not.toBeDisabled();
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

  it("queues the latest multi-agent slider save while a previous one is still in flight", async () => {
    const firstSave = createDeferred<ReturnType<typeof makeWorkspaceSnapshot>["settings"]>();
    mockedBridge.updateGlobalSettings
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce(
        makeGlobalSettings({
          multiAgentNudgeEnabled: true,
          multiAgentNudgeMaxSubagents: 6,
        }),
      );

    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        settings: makeGlobalSettings({
          multiAgentNudgeEnabled: true,
          multiAgentNudgeMaxSubagents: 4,
        }),
      }),
    }));

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const slider = screen.getByRole("slider", { name: "Max subagents" });

    fireEvent.change(slider, { target: { value: "5" } });
    fireEvent.pointerUp(slider);

    await waitFor(() => {
      expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledWith({
        multiAgentNudgeMaxSubagents: 5,
      });
    });
    expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledTimes(1);

    fireEvent.change(slider, { target: { value: "6" } });
    fireEvent.pointerUp(slider);

    expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledTimes(1);

    firstSave.resolve(
      makeGlobalSettings({
        multiAgentNudgeEnabled: true,
        multiAgentNudgeMaxSubagents: 5,
      }),
    );

    await waitFor(() => {
      expect(mockedBridge.updateGlobalSettings).toHaveBeenCalledTimes(2);
    });
    expect(mockedBridge.updateGlobalSettings).toHaveBeenLastCalledWith({
      multiAgentNudgeMaxSubagents: 6,
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

  it("reuses friendly model labels in settings when runtime capabilities are available", async () => {
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
    expect(modelPicker).toHaveTextContent("GPT-5.4 Mini");

    await userEvent.click(modelPicker);

    expect(
      screen.getByRole("option", { name: "GPT-5.4 Mini" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "gpt-5.4-mini" })).toBeNull();
  });

  it("uses the selected project's local environment capabilities when no environment is selected", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        settings: {
          ...makeWorkspaceSnapshot().settings,
          defaultModel: "gpt-5.4-mini",
        },
        projects: [
          makeProject({
            id: "project-1",
            environments: [
              {
                ...makeProject().environments[0]!,
                id: "env-local",
                kind: "local",
              },
            ],
          }),
        ],
      }),
      selectedProjectId: "project-1",
      selectedEnvironmentId: null,
      selectedThreadId: null,
    }));
    useConversationStore.setState((state) => ({
      ...state,
      capabilitiesByEnvironmentId: {
        "env-local": {
          environmentId: "env-local",
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
    expect(modelPicker).toHaveTextContent("GPT-5.4 Mini");
  });

  it("falls back to the selected project's default environment when no local environment is available", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        settings: {
          ...makeWorkspaceSnapshot().settings,
          defaultModel: "gpt-5.4-mini",
        },
        projects: [
          makeProject({
            id: "project-1",
            environments: [
              makeEnvironment({
                id: "env-secondary",
                kind: "managedWorktree",
                isDefault: false,
              }),
              makeEnvironment({
                id: "env-default",
                kind: "managedWorktree",
                isDefault: true,
              }),
            ],
          }),
        ],
      }),
      selectedProjectId: "project-1",
      selectedEnvironmentId: null,
      selectedThreadId: null,
    }));
    useConversationStore.setState((state) => ({
      ...state,
      capabilitiesByEnvironmentId: {
        "env-default": {
          environmentId: "env-default",
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
    expect(modelPicker).toHaveTextContent("GPT-5.4 Mini");
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
          manualActions: [],
          worktreeSetupScript: "pnpm install",
          worktreeTeardownScript: "./scripts/cleanup.sh",
        },
      });
    });
  });

  it("saves manual project actions from the Project settings tab", async () => {
    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Project" }));
    await userEvent.click(screen.getByRole("button", { name: "Add action" }));

    await userEvent.type(screen.getByLabelText("Label"), "Dev");
    await userEvent.type(screen.getByLabelText("Script"), "bun run dev");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockedBridge.updateProjectSettings).toHaveBeenCalledWith({
        projectId: "project-1",
        patch: {
          worktreeSetupScript: null,
          worktreeTeardownScript: null,
          manualActions: [
            expect.objectContaining({
              label: "Dev",
              icon: "play",
              script: "bun run dev",
              shortcut: null,
            }),
          ],
        },
      });
    });
  });

  it("creates manual project actions from the studio action control", async () => {
    mockedBridge.updateProjectSettings.mockImplementation(async ({ projectId, patch }) =>
      makeProject({
        id: projectId,
        settings: {
          worktreeSetupScript: patch.worktreeSetupScript ?? undefined,
          worktreeTeardownScript: patch.worktreeTeardownScript ?? undefined,
          manualActions: patch.manualActions ?? [],
        },
      }),
    );

    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Open action dialog" }));
    expect(screen.getByRole("dialog", { name: "Add Action" })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Label"), "Dev");
    await userEvent.type(screen.getByLabelText("Script"), "bun run dev");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockedBridge.updateProjectSettings).toHaveBeenCalledWith({
        projectId: "project-1",
        patch: {
          manualActions: [
            expect.objectContaining({
              label: "Dev",
              icon: "play",
              script: "bun run dev",
              shortcut: null,
            }),
          ],
        },
      });
    });
    const actionCreateCall =
      mockedBridge.updateProjectSettings.mock.calls[
        mockedBridge.updateProjectSettings.mock.calls.length - 1
      ]?.[0];
    expect(actionCreateCall?.patch).not.toHaveProperty("worktreeSetupScript");
    expect(actionCreateCall?.patch).not.toHaveProperty("worktreeTeardownScript");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Add Action" })).toBeNull();
    });
    expect(
      useWorkspaceStore.getState().snapshot?.projects[0]?.settings.manualActions,
    ).toEqual([
      expect.objectContaining({
        label: "Dev",
        icon: "play",
        script: "bun run dev",
        shortcut: null,
      }),
    ]);
  });

  it("moves focus into the action dialog and restores it when the dialog closes", async () => {
    render(<StudioShell />);

    const opener = screen.getByRole("button", { name: "Open action dialog" });
    await userEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Add Action" });
    await waitFor(() => {
      expect(dialog).toHaveFocus();
    });

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it("disables studio shortcuts while the action dialog is open", async () => {
    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Open action dialog" }));

    fireEvent.keyDown(window, {
      key: "j",
      ...primaryModifier(),
    });

    expect(selectTerminalSlot("env-1")(useTerminalStore.getState()).visible).toBe(false);
  });

  it("traps tab navigation inside the action dialog", async () => {
    const user = userEvent.setup();

    render(<StudioShell />);

    await user.click(screen.getByRole("button", { name: "Open action dialog" }));

    const closeButton = screen.getByRole("button", {
      name: "Close add action dialog",
    });
    const createButton = screen.getByRole("button", { name: "Create" });

    createButton.focus();
    await user.tab();
    expect(closeButton).toHaveFocus();

    closeButton.focus();
    await user.tab({ shift: true });
    expect(createButton).toHaveFocus();
  });

  it("treats icon selection and shift-tab shortcut navigation accessibly", async () => {
    const user = userEvent.setup();

    render(<StudioShell />);

    await user.click(screen.getByRole("button", { name: "Open action dialog" }));
    const iconButtons = screen.getAllByRole("button").filter((button) =>
      button.className.includes("settings-project-action__icon-btn"),
    );

    expect(iconButtons[0]).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(iconButtons[1]).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    const shortcutInput = screen.getByLabelText("Project action shortcut");
    await user.click(shortcutInput);
    await user.tab({ shift: true });

    expect((shortcutInput as HTMLInputElement).value).toBe("Not set");
    expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();
  });

  it("blocks studio action creation when the shortcut conflicts with global settings", async () => {
    render(<StudioShell />);

    await userEvent.click(screen.getByRole("button", { name: "Open action dialog" }));
    await userEvent.type(screen.getByLabelText("Label"), "Dev");
    await userEvent.type(screen.getByLabelText("Script"), "bun run dev");

    const shortcutInput = screen.getByLabelText("Dev shortcut");
    await userEvent.click(shortcutInput);
    fireEvent.keyDown(shortcutInput, { key: "j", ctrlKey: true });
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText("Toggle terminal already uses this shortcut."),
    ).toBeInTheDocument();
    expect(mockedBridge.updateProjectSettings).not.toHaveBeenCalled();
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
        "Project settings were saved, but the workspace snapshot could not be refreshed.",
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
          makeProject({ id: "project-1", name: "Skein" }),
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
          makeProject({ id: "project-1", name: "Skein" }),
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
