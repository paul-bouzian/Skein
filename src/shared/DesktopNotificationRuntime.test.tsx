import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as notifications from "@tauri-apps/plugin-notification";

import {
  INITIAL_CONVERSATION_STATE,
  useConversationStore,
} from "../stores/conversation-store";
import { useWorkspaceStore } from "../stores/workspace-store";
import {
  makeApprovalRequest,
  makeConversationSnapshot,
  makeEnvironment,
  makeGlobalSettings,
  makeProject,
  makeThread,
  makeWorkspaceSnapshot,
} from "../test/fixtures/conversation";
import { DesktopNotificationRuntime } from "./DesktopNotificationRuntime";

vi.mock("@tauri-apps/plugin-notification", () => ({
  sendNotification: vi.fn(),
}));

const mockedNotifications = vi.mocked(notifications);

let visibilityState: DocumentVisibilityState = "visible";
let hasFocus = true;

function setBackgroundState(background: boolean) {
  visibilityState = background ? "hidden" : "visible";
  hasFocus = !background;
  window.dispatchEvent(new Event(background ? "blur" : "focus"));
  document.dispatchEvent(new Event("visibilitychange"));
}

function makeRuntimeWorkspaceSnapshot(desktopNotificationsEnabled: boolean) {
  return makeWorkspaceSnapshot({
    settings: makeGlobalSettings({ desktopNotificationsEnabled }),
    projects: [
      makeProject({
        environments: [
          makeEnvironment({
            id: "env-1",
            name: "Feature Branch",
            threads: [
              makeThread({
                id: "thread-1",
                environmentId: "env-1",
                title: "Ship desktop notifications",
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function makeRuntimeWorkspaceSnapshotWithThreads(
  desktopNotificationsEnabled: boolean,
  threads: ReturnType<typeof makeThread>[],
) {
  return makeWorkspaceSnapshot({
    settings: makeGlobalSettings({ desktopNotificationsEnabled }),
    projects: [
      makeProject({
        environments: [
          makeEnvironment({
            id: "env-1",
            name: "Feature Branch",
            threads,
          }),
        ],
      }),
    ],
  });
}

beforeEach(() => {
  visibilityState = "visible";
  hasFocus = true;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    value: vi.fn(() => hasFocus),
  });
  mockedNotifications.sendNotification.mockReset();
  useConversationStore.setState({
    ...useConversationStore.getState(),
    ...INITIAL_CONVERSATION_STATE,
  });
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: makeRuntimeWorkspaceSnapshot(false),
  }));
});

describe("DesktopNotificationRuntime", () => {
  it("does not notify for the initial snapshot hydration", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeRuntimeWorkspaceSnapshot(true),
    }));
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          environmentId: "env-1",
          status: "completed",
          activeTurnId: null,
        }),
      },
    }));

    render(<DesktopNotificationRuntime />);

    expect(mockedNotifications.sendNotification).not.toHaveBeenCalled();
  });

  it("sends a completion notification when a thread completes in the background", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeRuntimeWorkspaceSnapshot(true),
    }));
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          environmentId: "env-1",
          status: "running",
          activeTurnId: "turn-1",
        }),
      },
    }));

    render(<DesktopNotificationRuntime />);

    await act(async () => {
      setBackgroundState(true);
      useConversationStore.setState((state) => ({
        ...state,
        snapshotsByThreadId: {
          "thread-1": makeConversationSnapshot({
            threadId: "thread-1",
            environmentId: "env-1",
            status: "completed",
            activeTurnId: null,
            pendingInteractions: [],
            proposedPlan: null,
          }),
        },
      }));
    });

    await waitFor(() => {
      expect(mockedNotifications.sendNotification).toHaveBeenCalledWith({
        title: "Ship desktop notifications",
        body: "Finished working in Feature Branch.",
      });
    });
  });

  it("sends an attention notification with approval copy in the background", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeRuntimeWorkspaceSnapshot(true),
    }));
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          environmentId: "env-1",
          status: "running",
          activeTurnId: "turn-1",
          pendingInteractions: [],
          proposedPlan: null,
        }),
      },
    }));

    render(<DesktopNotificationRuntime />);

    await act(async () => {
      setBackgroundState(true);
      useConversationStore.setState((state) => ({
        ...state,
        snapshotsByThreadId: {
          "thread-1": makeConversationSnapshot({
            threadId: "thread-1",
            environmentId: "env-1",
            status: "waitingForExternalAction",
            activeTurnId: "turn-1",
            pendingInteractions: [makeApprovalRequest()],
            proposedPlan: null,
          }),
        },
      }));
    });

    await waitFor(() => {
      expect(mockedNotifications.sendNotification).toHaveBeenCalledWith({
        title: "Ship desktop notifications",
        body: "Needs your approval in Feature Branch.",
      });
    });
  });

  it("suppresses unknown threads only for the first hydration update", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeRuntimeWorkspaceSnapshotWithThreads(true, [
        makeThread({
          id: "thread-1",
          environmentId: "env-1",
          title: "Initial hydrated thread",
        }),
        makeThread({
          id: "thread-2",
          environmentId: "env-1",
          title: "New background approval",
        }),
      ]),
    }));

    render(<DesktopNotificationRuntime />);

    await act(async () => {
      setBackgroundState(true);
      useConversationStore.setState((state) => ({
        ...state,
        snapshotsByThreadId: {
          "thread-1": makeConversationSnapshot({
            threadId: "thread-1",
            environmentId: "env-1",
            status: "waitingForExternalAction",
            activeTurnId: "turn-1",
            pendingInteractions: [makeApprovalRequest()],
            proposedPlan: null,
          }),
        },
      }));
    });

    expect(mockedNotifications.sendNotification).not.toHaveBeenCalled();

    await act(async () => {
      useConversationStore.setState((state) => ({
        ...state,
        snapshotsByThreadId: {
          ...state.snapshotsByThreadId,
          "thread-2": makeConversationSnapshot({
            threadId: "thread-2",
            environmentId: "env-1",
            status: "waitingForExternalAction",
            activeTurnId: "turn-2",
            pendingInteractions: [makeApprovalRequest({ id: "approval-2" })],
            proposedPlan: null,
          }),
        },
      }));
    });

    await waitFor(() => {
      expect(mockedNotifications.sendNotification).toHaveBeenCalledWith({
        title: "New background approval",
        body: "Needs your approval in Feature Branch.",
      });
    });
  });

  it("does not notify when desktop notifications are disabled", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeRuntimeWorkspaceSnapshot(false),
    }));
    useConversationStore.setState((state) => ({
      ...state,
      snapshotsByThreadId: {
        "thread-1": makeConversationSnapshot({
          threadId: "thread-1",
          environmentId: "env-1",
          status: "running",
          activeTurnId: "turn-1",
        }),
      },
    }));

    render(<DesktopNotificationRuntime />);

    await act(async () => {
      setBackgroundState(true);
      useConversationStore.setState((state) => ({
        ...state,
        snapshotsByThreadId: {
          "thread-1": makeConversationSnapshot({
            threadId: "thread-1",
            environmentId: "env-1",
            status: "completed",
            activeTurnId: null,
            pendingInteractions: [],
            proposedPlan: null,
          }),
        },
      }));
    });

    expect(mockedNotifications.sendNotification).not.toHaveBeenCalled();
  });
});
