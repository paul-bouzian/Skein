import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isMacPlatform } from "../../lib/shortcuts";
import {
  capabilitiesFixture,
  makeConversationSnapshot,
  makeEnvironment,
  makeProject,
  makeProposedPlan,
  makeThread,
  makeWorkspaceSnapshot,
} from "../../test/fixtures/conversation";
import { useConversationStore } from "../../stores/conversation-store";
import { useTerminalStore } from "../../stores/terminal-store";
import { useWorkspaceStore } from "../../stores/workspace-store";
import { useStudioShortcuts } from "./useStudioShortcuts";

vi.mock("../../lib/bridge", () => ({
  archiveThread: vi.fn(),
  createManagedWorktree: vi.fn(),
  createThread: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
  message: vi.fn(),
}));

function isTerminalVisible(environmentId = "env-1") {
  const state = useTerminalStore.getState() as {
    visible?: boolean;
    byEnv: Record<string, { visible?: boolean } | undefined>;
  };

  return state.visible ?? state.byEnv[environmentId]?.visible ?? false;
}

type HarnessProps = {
  onOpenSettings?: () => void;
  onRender?: () => void;
  onRequestApproveOrSubmit?: () => void;
  renderComposerInput?: boolean;
  shortcutsBlocked?: boolean;
};

function Harness({
  onOpenSettings = vi.fn(),
  onRender,
  onRequestApproveOrSubmit = vi.fn(),
  renderComposerInput = false,
  shortcutsBlocked = false,
}: HarnessProps) {
  onRender?.();
  useStudioShortcuts({
    shortcutsBlocked,
    onOpenSettings,
    onRequestApproveOrSubmit,
    onRequestComposerFocus: vi.fn(),
    onToggleProjectsSidebar: vi.fn(),
    onToggleReviewPanel: vi.fn(),
  });
  return (
    <div data-testid="shortcut-harness">
      {renderComposerInput ? (
        <div className="tx-composer">
          <textarea aria-label="Composer input" />
        </div>
      ) : null}
      <input aria-label="Other input" />
    </div>
  );
}

describe("useStudioShortcuts", () => {
  const primaryModifier = () => (isMacPlatform() ? { metaKey: true } : { ctrlKey: true });

  beforeEach(() => {
    vi.clearAllMocks();
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
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
      selectedThreadId: "thread-1",
    }));
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: {
        "thread-1": makeConversationSnapshot(),
      },
      capabilitiesByEnvironmentId: {
        "env-1": capabilitiesFixture,
      },
      composerByThreadId: {},
      hydrationByThreadId: {},
      errorByThreadId: {},
      listenerReady: false,
    }));
    useTerminalStore.setState({
      byEnv: {},
      knownEnvironmentIds: [],
    });
  });

  it("routes approve-or-submit through the shared request callback for awaiting plans", () => {
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: {
        ...state.snapshotsByThreadId,
        "thread-1": makeConversationSnapshot({
          status: "waitingForExternalAction",
          proposedPlan: makeProposedPlan(),
        }),
      },
    }));
    const onRequestApproveOrSubmit = vi.fn();

    render(<Harness onRequestApproveOrSubmit={onRequestApproveOrSubmit} />);

    fireEvent.keyDown(window, {
      key: "Enter",
      ...primaryModifier(),
    });

    expect(onRequestApproveOrSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps a single keydown listener while conversation snapshots stream", () => {
    const onRender = vi.fn();
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");

    render(<Harness onRender={onRender} />);

    const initialRenderCount = onRender.mock.calls.length;
    const initialKeydownAdds = addEventListenerSpy.mock.calls.filter(
      ([type]) => type === "keydown",
    ).length;

    act(() => {
      useConversationStore.setState((state) => ({
        ...state,
        snapshotsByThreadId: {
          ...state.snapshotsByThreadId,
          "thread-1": makeConversationSnapshot({
            status: "running",
            proposedPlan: makeProposedPlan({
              isAwaitingDecision: false,
            }),
          }),
        },
      }));
    });

    expect(onRender.mock.calls.length).toBe(initialRenderCount);
    expect(
      addEventListenerSpy.mock.calls.filter(([type]) => type === "keydown").length,
    ).toBe(initialKeydownAdds);
    expect(
      removeEventListenerSpy.mock.calls.filter(([type]) => type === "keydown").length,
    ).toBe(0);
  });

  it("cycles collaboration mode from the composer textarea", () => {
    render(<Harness renderComposerInput />);

    fireEvent.keyDown(screen.getByLabelText("Composer input"), {
      key: "Tab",
      shiftKey: true,
    });

    expect(
      useConversationStore.getState().composerByThreadId["thread-1"]?.collaborationMode,
    ).toBe("plan");
  });

  it("cycles model and reasoning from the composer textarea", () => {
    useConversationStore.setState((state) => ({
      ...state,
      capabilitiesByEnvironmentId: {
        "env-1": {
          ...capabilitiesFixture,
          models: [
            capabilitiesFixture.models[0]!,
            {
              id: "gpt-5.4-mini",
              displayName: "GPT-5.4 Mini",
              description: "Smaller Codex model",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["medium", "high"],
              inputModalities: ["text"],
              isDefault: false,
            },
          ],
        },
      },
    }));
    render(<Harness renderComposerInput />);

    const textarea = screen.getByLabelText("Composer input");
    fireEvent.keyDown(textarea, {
      key: "R",
      shiftKey: true,
      ...primaryModifier(),
    });
    fireEvent.keyDown(textarea, {
      key: "M",
      shiftKey: true,
      ...primaryModifier(),
    });

    expect(
      useConversationStore.getState().composerByThreadId["thread-1"]?.reasoningEffort,
    ).toBe("xhigh");
    expect(useConversationStore.getState().composerByThreadId["thread-1"]?.model).toBe(
      "gpt-5.4-mini",
    );
  });

  it("keeps composer shortcuts blocked in unrelated editable fields", () => {
    render(<Harness />);

    fireEvent.keyDown(screen.getByLabelText("Other input"), {
      key: "Tab",
      shiftKey: true,
    });

    expect(useConversationStore.getState().composerByThreadId["thread-1"]).toBeUndefined();
  });

  it("skips studio shortcuts while a modal blocks them", async () => {
    render(<Harness shortcutsBlocked />);

    fireEvent.keyDown(window, {
      key: "j",
      ...primaryModifier(),
    });

    await waitFor(() => {
      expect(isTerminalVisible()).toBe(false);
    });
  });

  it("launches a project action from its shortcut in the selected environment", () => {
    const openActionTab = vi.fn(async () => "action-tab");
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            settings: {
              worktreeSetupScript: undefined,
              worktreeTeardownScript: undefined,
              manualActions: [
                {
                  id: "dev",
                  label: "Dev",
                  icon: "play",
                  script: "bun run dev",
                  shortcut: "mod+shift+d",
                },
              ],
            },
          }),
        ],
      }),
    }));
    useTerminalStore.setState({ openActionTab });

    render(<Harness />);

    fireEvent.keyDown(window, {
      key: "D",
      shiftKey: true,
      ...primaryModifier(),
    });

    expect(openActionTab).toHaveBeenCalledWith("env-1", {
      id: "dev",
      label: "Dev",
      icon: "play",
      script: "bun run dev",
      shortcut: "mod+shift+d",
    });
  });

  it("keeps core shortcuts ahead of conflicting project action shortcuts", () => {
    const openActionTab = vi.fn(async () => "action-tab");
    const toggleVisible = vi.fn();
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            settings: {
              worktreeSetupScript: undefined,
              worktreeTeardownScript: undefined,
              manualActions: [
                {
                  id: "dev",
                  label: "Dev",
                  icon: "play",
                  script: "bun run dev",
                  shortcut: "mod+j",
                },
              ],
            },
          }),
        ],
      }),
    }));
    useTerminalStore.setState({ openActionTab, toggleVisible });

    render(<Harness />);

    fireEvent.keyDown(window, {
      key: "J",
      ...primaryModifier(),
    });

    expect(toggleVisible).toHaveBeenCalledTimes(1);
    expect(toggleVisible).toHaveBeenCalledWith("env-1");
    expect(openActionTab).not.toHaveBeenCalled();
  });

  it("shows a warning when a project action shortcut cannot open a terminal tab", async () => {
    const openActionTab = vi.fn(async () => null);
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            settings: {
              worktreeSetupScript: undefined,
              worktreeTeardownScript: undefined,
              manualActions: [
                {
                  id: "dev",
                  label: "Dev",
                  icon: "play",
                  script: "bun run dev",
                  shortcut: "mod+shift+d",
                },
              ],
            },
          }),
        ],
      }),
    }));
    useTerminalStore.setState({ openActionTab });

    render(<Harness />);

    fireEvent.keyDown(window, {
      key: "D",
      shiftKey: true,
      ...primaryModifier(),
    });

    const { message } = await import("@tauri-apps/plugin-dialog");
    await waitFor(() => {
      expect(message).toHaveBeenCalledWith(
        "Maximum 10 terminals are open in this environment.",
        {
          title: "Project action",
          kind: "warning",
        },
      );
    });
  });

  it("toggles the local terminal while a draft pane is focused", async () => {
    const toggleVisible = vi.fn();
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
    useTerminalStore.setState({ toggleVisible });

    render(<Harness />);

    fireEvent.keyDown(window, {
      key: "J",
      ...primaryModifier(),
    });

    expect(toggleVisible).toHaveBeenCalledWith("env-1");
    expect(useWorkspaceStore.getState().selectedEnvironmentId).toBeNull();
  });

  it("does not navigate away from a focused draft pane when cycling threads", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        projects: [
          makeProject({
            environments: [
              makeEnvironment({
                id: "env-1",
                threads: [
                  makeThread({ id: "thread-1", environmentId: "env-1" }),
                  makeThread({ id: "thread-2", environmentId: "env-1" }),
                ],
              }),
            ],
          }),
        ],
      }),
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

    render(<Harness />);

    fireEvent.keyDown(window, {
      key: "]",
      shiftKey: true,
      ...primaryModifier(),
    });

    expect(useWorkspaceStore.getState().draftBySlot.topLeft).toEqual({
      projectId: "project-1",
    });
    expect(useWorkspaceStore.getState().selectedThreadId).toBeNull();
    expect(useWorkspaceStore.getState().selectedEnvironmentId).toBeNull();
  });
});
