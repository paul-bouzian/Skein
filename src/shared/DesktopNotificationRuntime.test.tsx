import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as notificationSounds from "../lib/notification-sounds";
import { notificationSendMock } from "../test/desktop-mock";

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


vi.mock("../lib/notification-sounds", () => ({
  playNotificationAlertSound: vi.fn(),
}));

const mockedNotificationSounds = vi.mocked(notificationSounds);

let visibilityState: DocumentVisibilityState = "visible";
let hasFocus = true;

function setBackgroundState(background: boolean) {
  visibilityState = background ? "hidden" : "visible";
  hasFocus = !background;
  window.dispatchEvent(new Event(background ? "blur" : "focus"));
  document.dispatchEvent(new Event("visibilitychange"));
}

function makeRuntimeWorkspaceSnapshot({
  desktopNotificationsEnabled,
  notificationSoundOverrides,
  threads,
}: {
  desktopNotificationsEnabled: boolean;
  notificationSoundOverrides?: Partial<
    ReturnType<typeof makeGlobalSettings>["notificationSounds"]
  >;
  threads?: ReturnType<typeof makeThread>[];
}) {
  const baseSettings = makeGlobalSettings();
  return makeWorkspaceSnapshot({
    settings: makeGlobalSettings({
      desktopNotificationsEnabled,
      notificationSounds: {
        attention: {
          ...baseSettings.notificationSounds.attention,
          ...notificationSoundOverrides?.attention,
        },
        completion: {
          ...baseSettings.notificationSounds.completion,
          ...notificationSoundOverrides?.completion,
        },
      },
    }),
    projects: [
      makeProject({
        environments: [
          makeEnvironment({
            id: "env-1",
            name: "Feature Branch",
            threads:
              threads ??
              [
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
  notificationSendMock.mockReset();
  notificationSendMock.mockResolvedValue(undefined);
  mockedNotificationSounds.playNotificationAlertSound.mockReset();
  mockedNotificationSounds.playNotificationAlertSound.mockResolvedValue(undefined);
  useConversationStore.setState({
    ...useConversationStore.getState(),
    ...INITIAL_CONVERSATION_STATE,
  });
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: makeRuntimeWorkspaceSnapshot({
      desktopNotificationsEnabled: false,
    }),
    selectedThreadId: "thread-1",
  }));
});

describe("DesktopNotificationRuntime", () => {
  it("does not notify for the initial snapshot hydration", () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeRuntimeWorkspaceSnapshot({
        desktopNotificationsEnabled: true,
      }),
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

    expect(notificationSendMock).not.toHaveBeenCalled();
    expect(mockedNotificationSounds.playNotificationAlertSound).not.toHaveBeenCalled();
  });

  it("sends a completion notification when a thread completes in the background", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeRuntimeWorkspaceSnapshot({
        desktopNotificationsEnabled: true,
      }),
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
      expect(notificationSendMock).toHaveBeenCalledWith({
        title: "Ship desktop notifications",
        body: "Finished working in Feature Branch.",
      });
    });
    expect(mockedNotificationSounds.playNotificationAlertSound).not.toHaveBeenCalled();
  });

  it("sends an attention notification with approval copy in the background", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeRuntimeWorkspaceSnapshot({
        desktopNotificationsEnabled: true,
      }),
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
      expect(notificationSendMock).toHaveBeenCalledWith({
        title: "Ship desktop notifications",
        body: "Needs your approval in Feature Branch.",
      });
    });
    expect(mockedNotificationSounds.playNotificationAlertSound).not.toHaveBeenCalled();
  });

  it("suppresses unknown threads only for the first hydration update", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeRuntimeWorkspaceSnapshot({
        desktopNotificationsEnabled: true,
        threads: [
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
        ],
      }),
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

    expect(notificationSendMock).not.toHaveBeenCalled();

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
      expect(notificationSendMock).toHaveBeenCalledWith({
        title: "New background approval",
        body: "Needs your approval in Feature Branch.",
      });
    });
  });

  it("does not notify when desktop notifications are disabled", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeRuntimeWorkspaceSnapshot({
        desktopNotificationsEnabled: false,
      }),
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

    expect(notificationSendMock).not.toHaveBeenCalled();
    expect(mockedNotificationSounds.playNotificationAlertSound).not.toHaveBeenCalled();
  });

  it("plays the completion sound when a thread completes in the background", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeRuntimeWorkspaceSnapshot({
        desktopNotificationsEnabled: false,
        notificationSoundOverrides: {
          completion: {
            enabled: true,
            sound: "chord",
          },
        },
      }),
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
      expect(mockedNotificationSounds.playNotificationAlertSound).toHaveBeenCalledWith(
        "chord",
      );
    });
    expect(notificationSendMock).not.toHaveBeenCalled();
  });

  it("plays an attention sound in the foreground when another thread needs input", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeRuntimeWorkspaceSnapshot({
        desktopNotificationsEnabled: false,
        notificationSoundOverrides: {
          attention: {
            enabled: true,
            sound: "glass",
          },
          completion: {
            enabled: false,
            sound: "polite",
          },
        },
        threads: [
          makeThread({
            id: "thread-1",
            environmentId: "env-1",
            title: "Current thread",
          }),
          makeThread({
            id: "thread-2",
            environmentId: "env-1",
            title: "Background approval",
          }),
        ],
      }),
      selectedThreadId: "thread-1",
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
      setBackgroundState(false);
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
      expect(mockedNotificationSounds.playNotificationAlertSound).toHaveBeenCalledWith(
        "glass",
      );
    });
  });

  it("does not play a sound in the foreground when the selected thread needs input", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeRuntimeWorkspaceSnapshot({
        desktopNotificationsEnabled: false,
        notificationSoundOverrides: {
          attention: {
            enabled: true,
            sound: "glass",
          },
        },
      }),
      selectedThreadId: "thread-1",
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
      setBackgroundState(false);
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

    expect(mockedNotificationSounds.playNotificationAlertSound).not.toHaveBeenCalled();
  });

  it("prefers an attention sound over a completion sound when both happen together", async () => {
    useWorkspaceStore.setState((state) => ({
      ...state,
      snapshot: makeWorkspaceSnapshot({
        settings: makeGlobalSettings({
          desktopNotificationsEnabled: false,
          notificationSounds: {
            attention: {
              enabled: true,
              sound: "glass",
            },
            completion: {
              enabled: true,
              sound: "chord",
            },
          },
        }),
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
                    title: "Completing thread",
                  }),
                  makeThread({
                    id: "thread-2",
                    environmentId: "env-1",
                    title: "Attention thread",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      selectedThreadId: "thread-3",
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
        "thread-2": makeConversationSnapshot({
          threadId: "thread-2",
          environmentId: "env-1",
          status: "running",
          activeTurnId: "turn-2",
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
            status: "completed",
            activeTurnId: null,
            pendingInteractions: [],
            proposedPlan: null,
          }),
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
      expect(mockedNotificationSounds.playNotificationAlertSound).toHaveBeenCalledWith(
        "glass",
      );
    });
  });
});
