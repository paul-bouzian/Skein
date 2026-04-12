import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isMacPlatform } from "../../lib/shortcuts";
import {
  capabilitiesFixture,
  makeConversationSnapshot,
  makeProposedPlan,
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
}));

type HarnessProps = {
  onOpenSettings?: () => void;
  onRender?: () => void;
  onRequestApproveOrSubmit?: () => void;
  renderComposerInput?: boolean;
  settingsOpen?: boolean;
};

function Harness({
  onOpenSettings = vi.fn(),
  onRender,
  onRequestApproveOrSubmit = vi.fn(),
  renderComposerInput = false,
  settingsOpen = false,
}: HarnessProps) {
  onRender?.();
  useStudioShortcuts({
    settingsOpen,
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
      visible: false,
      height: 280,
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
});
