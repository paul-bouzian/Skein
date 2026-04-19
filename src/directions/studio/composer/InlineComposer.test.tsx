import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";

import * as bridge from "../../../lib/bridge";
import type { ComposerDraftMentionBinding } from "../../../lib/types";
import {
  baseComposer,
  capabilitiesFixture,
  makeEnvironment,
  makeProject,
  makeWorkspaceSnapshot,
} from "../../../test/fixtures/conversation";
import { resetVoiceSessionStore } from "../../../stores/voice-session-store";
import { useVoiceStatusStore } from "../../../stores/voice-status-store";
import { useWorkspaceStore } from "../../../stores/workspace-store";
import { InlineComposer } from "./InlineComposer";
import { startVoiceCapture } from "./composer-voice-audio";

vi.mock("../../../lib/bridge", () => ({
  getThreadComposerCatalog: vi.fn(),
  searchThreadFiles: vi.fn(),
  readImageAsDataUrl: vi.fn(),
  getEnvironmentVoiceStatus: vi.fn(),
  transcribeEnvironmentVoice: vi.fn(),
}));

vi.mock("./composer-voice-audio", () => ({
  MAX_RECORDING_DURATION_MS: 120_000,
  startVoiceCapture: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onDragDropEvent: vi.fn(async () => () => undefined),
  })),
}));

const mockedBridge = vi.mocked(bridge);
const mockedStartVoiceCapture = vi.mocked(startVoiceCapture);

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
  vi.clearAllMocks();
  await resetVoiceSessionStore();
  useWorkspaceStore.setState((state) => ({
    ...state,
    snapshot: makeWorkspaceSnapshot({
      projects: [
        makeProject({
          environments: [makeEnvironment({ id: "env-1" })],
        }),
      ],
    }),
  }));
  useVoiceStatusStore.setState((state) => ({
    ...state,
    snapshotsByEnvironmentId: {},
    loadingByEnvironmentId: {},
    errorByEnvironmentId: {},
    lastFetchedAtByEnvironmentId: {},
    lastRequestedAtByEnvironmentId: {},
  }));
  mockedBridge.getThreadComposerCatalog.mockResolvedValue({
    prompts: [],
    skills: [],
    apps: [],
  });
  mockedBridge.searchThreadFiles.mockResolvedValue([]);
  mockedBridge.readImageAsDataUrl.mockResolvedValue(
    "data:image/png;base64,aGVsbG8=",
  );
  mockedBridge.getEnvironmentVoiceStatus.mockResolvedValue({
    environmentId: "env-1",
    available: true,
    authMode: "chatgpt",
    unavailableReason: null,
    message: null,
  });

  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(),
    },
  });
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: class FakeAudioContext {},
  });
  vi.mocked(open).mockResolvedValue(null);
});

describe("InlineComposer voice dictation", () => {
  it("records, transcribes, and inserts text into an empty draft", async () => {
    mockedStartVoiceCapture.mockResolvedValue(makeCapture());
    mockedBridge.transcribeEnvironmentVoice.mockResolvedValue({
      text: "Transcribed words",
    });

    const { container } = renderComposer("");

    const startButton = await screen.findByRole("button", {
      name: "Start voice dictation",
    });
    await waitFor(() => {
      expect(startButton).toBeEnabled();
    });

    await userEvent.click(startButton);
    expect(mockedStartVoiceCapture).toHaveBeenCalledTimes(1);
    const recordingButton = await screen.findByRole("button", {
      name: "Stop voice dictation",
    });
    const voiceControl = recordingButton.closest(".tx-composer__voice-control");
    expect(voiceControl).toHaveTextContent(/\d{2}:\d{2}/);
    expect(recordingButton).toHaveClass("tx-composer__voice-button--recording");
    expect(container.querySelector(".tx-voice-capsule")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();

    await userEvent.click(recordingButton);

    await waitFor(() => {
      expect(mockedBridge.transcribeEnvironmentVoice).toHaveBeenCalledWith({
        environmentId: "env-1",
        audioBase64: "dGVzdA==",
        durationMs: 1_200,
        mimeType: "audio/wav",
        sampleRateHz: 24_000,
      });
    });
    expect(
      await screen.findByDisplayValue("Transcribed words"),
    ).toBeInTheDocument();
  });

  it("appends transcript to an existing draft with one separator space", async () => {
    mockedStartVoiceCapture.mockResolvedValue(makeCapture());
    mockedBridge.transcribeEnvironmentVoice.mockResolvedValue({
      text: "add rollback coverage",
    });

    renderComposer("Plan:");

    const startButton = await screen.findByRole("button", {
      name: "Start voice dictation",
    });
    await waitFor(() => {
      expect(startButton).toBeEnabled();
    });

    await userEvent.click(startButton);
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop voice dictation" }),
    );

    expect(
      await screen.findByDisplayValue("Plan: add rollback coverage"),
    ).toBeInTheDocument();
  });

  it("disables the microphone button and exposes the unavailable reason via tooltip", async () => {
    mockedBridge.getEnvironmentVoiceStatus.mockResolvedValue({
      environmentId: "env-1",
      available: false,
      authMode: "apiKey",
      unavailableReason: "chatgptRequired",
      message:
        "Voice transcription requires Sign in with ChatGPT. API-key auth is not supported.",
    });

    renderComposer("");

    const startButton = await screen.findByRole("button", {
      name: "Start voice dictation",
    });
    await waitFor(() => {
      expect(startButton).toBeDisabled();
    });
    expect(startButton.parentElement).toHaveAttribute(
      "title",
      "Voice transcription requires Sign in with ChatGPT. API-key auth is not supported.",
    );
    expect(
      screen.queryByText("Voice unavailable"),
    ).not.toBeInTheDocument();
  });

  it("exposes locked-state copy on the disabled microphone button", async () => {
    renderComposer("", { disabled: true });

    const startButton = await screen.findByRole("button", {
      name: "Start voice dictation",
    });
    await waitFor(() => {
      expect(startButton).toBeDisabled();
    });
    expect(startButton.parentElement).toHaveAttribute(
      "title",
      "Voice dictation is unavailable while the composer is locked",
    );
  });

  it("renders a local error when transcription fails and preserves the draft", async () => {
    mockedStartVoiceCapture.mockResolvedValue(makeCapture());
    mockedBridge.transcribeEnvironmentVoice.mockRejectedValue(
      new Error(
        "Your ChatGPT session has expired. Sign in again before using voice transcription.",
      ),
    );

    renderComposer("Keep draft");

    const startButton = await screen.findByRole("button", {
      name: "Start voice dictation",
    });
    await waitFor(() => {
      expect(startButton).toBeEnabled();
    });

    await userEvent.click(startButton);
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop voice dictation" }),
    );

    expect(
      await screen.findByText(/Voice transcription failed\./),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        "Your ChatGPT session has expired. Sign in again before using voice transcription.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Keep draft")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss voice error" }),
    );
    await waitFor(() => {
      expect(screen.queryByText(/Voice transcription failed\./)).toBeNull();
    });
  });

  it("appends the transcript onto the latest draft state after async transcription", async () => {
    const transcription = createDeferred<{ text: string }>();
    mockedStartVoiceCapture.mockResolvedValue(makeCapture());
    mockedBridge.transcribeEnvironmentVoice.mockReturnValue(transcription.promise);

    renderComposerWithExternalDraftAction("Plan:");

    const startButton = await screen.findByRole("button", {
      name: "Start voice dictation",
    });
    await waitFor(() => {
      expect(startButton).toBeEnabled();
    });

    await userEvent.click(startButton);
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop voice dictation" }),
    );

    await waitFor(() => {
      expect(mockedBridge.transcribeEnvironmentVoice).toHaveBeenCalledTimes(1);
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Set draft externally" }),
    );
    transcription.resolve({ text: "voice note" });

    expect(
      await screen.findByDisplayValue("Edited while transcribing voice note"),
    ).toBeInTheDocument();
  });

  it("updates the microphone copy while transcription is pending", async () => {
    const transcription = createDeferred<{ text: string }>();
    mockedStartVoiceCapture.mockResolvedValue(makeCapture());
    mockedBridge.transcribeEnvironmentVoice.mockReturnValue(transcription.promise);

    renderComposer("");

    const startButton = await screen.findByRole("button", {
      name: "Start voice dictation",
    });
    await waitFor(() => {
      expect(startButton).toBeEnabled();
    });

    await userEvent.click(startButton);
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop voice dictation" }),
    );

    const transcribingButton = await screen.findByRole("button", {
      name: "Transcribing voice dictation",
    });
    const voiceControl = transcribingButton.closest(".tx-composer__voice-control");
    expect(transcribingButton).toBeDisabled();
    expect(transcribingButton.parentElement).toHaveAttribute(
      "title",
      "Transcribing voice recording",
    );
    expect(voiceControl?.querySelector(".tx-composer__voice-spinner")).not.toBeNull();
    expect(voiceControl).not.toHaveTextContent(/\d{2}:\d{2}/);

    transcription.resolve({ text: "voice note" });

    expect(await screen.findByDisplayValue("voice note")).toBeInTheDocument();
  });

  it("allows canceling voice capture while the microphone is still starting", async () => {
    const capture = makeCapture();
    const startCapture = createDeferred<typeof capture>();
    mockedStartVoiceCapture.mockReturnValue(startCapture.promise);

    renderComposer("");

    const startButton = await screen.findByRole("button", {
      name: "Start voice dictation",
    });
    await waitFor(() => {
      expect(startButton).toBeEnabled();
    });

    await userEvent.click(startButton);

    const startingButton = await screen.findByRole("button", {
      name: "Starting voice dictation",
    });
    const voiceControl = startingButton.closest(".tx-composer__voice-control");
    expect(startingButton).toBeEnabled();
    expect(startingButton.parentElement).toHaveAttribute(
      "title",
      "Starting microphone capture. Click to cancel.",
    );
    expect(voiceControl?.querySelector(".tx-composer__voice-spinner")).not.toBeNull();

    await userEvent.click(startingButton);
    startCapture.resolve(capture);

    await waitFor(() => {
      expect(capture.cancel).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByRole("button", { name: "Start voice dictation" }),
    ).toBeEnabled();
    expect(voiceControl).not.toHaveTextContent(/\d{2}:\d{2}/);
  });

  it("keeps recording active when switching threads and restores it on return", async () => {
    const capture = makeCapture();
    mockedStartVoiceCapture.mockResolvedValue(capture);

    renderComposerWithDynamicThread("");

    const startButton = await screen.findByRole("button", {
      name: "Start voice dictation",
    });
    await waitFor(() => {
      expect(startButton).toBeEnabled();
    });

    await userEvent.click(startButton);
    const recordingButton = await screen.findByRole("button", {
      name: "Stop voice dictation",
    });
    expect(recordingButton.closest(".tx-composer__voice-control")).toHaveTextContent(
      /\d{2}:\d{2}/,
    );

    await userEvent.click(screen.getByRole("button", { name: "Switch to thread 2" }));

    const threadTwoVoiceButton = await screen.findByRole("button", {
      name: "Start voice dictation",
    });
    expect(threadTwoVoiceButton).toBeDisabled();
    expect(threadTwoVoiceButton.parentElement).toHaveAttribute(
      "title",
      expect.stringContaining("Voice dictation is already active"),
    );
    expect(
      threadTwoVoiceButton.closest(".tx-composer__voice-control"),
    ).not.toHaveTextContent(/\d{2}:\d{2}/);
    expect(capture.cancel).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Switch to thread 1" }));

    const resumedRecordingButton = await screen.findByRole("button", {
      name: "Stop voice dictation",
    });
    expect(
      resumedRecordingButton.closest(".tx-composer__voice-control"),
    ).toHaveTextContent(/\d{2}:\d{2}/);
    expect(capture.cancel).not.toHaveBeenCalled();
  });

  it("keeps the stop control available if transport drops mid-recording", async () => {
    const capture = makeCapture();
    mockedStartVoiceCapture.mockResolvedValue(capture);

    renderComposerWithDynamicTransport("");

    const startButton = await screen.findByRole("button", {
      name: "Start voice dictation",
    });
    await waitFor(() => {
      expect(startButton).toBeEnabled();
    });

    await userEvent.click(startButton);

    const stopButton = await screen.findByRole("button", {
      name: "Stop voice dictation",
    });
    await userEvent.click(screen.getByRole("button", { name: "Disable transport" }));

    expect(stopButton).toBeEnabled();
    await userEvent.click(stopButton);

    await waitFor(() => {
      expect(mockedBridge.transcribeEnvironmentVoice).toHaveBeenCalledTimes(1);
    });
  });

  it("can keep voice dictation enabled when thread transport is disabled", async () => {
    renderComposer("", {
      threadId: "draft:topLeft",
      transportEnabled: false,
      voiceEnabled: true,
    });

    const startButton = await screen.findByRole("button", {
      name: "Start voice dictation",
    });
    await waitFor(() => {
      expect(startButton).toBeEnabled();
    });
    expect(mockedBridge.getThreadComposerCatalog).not.toHaveBeenCalled();
  });

  it("uses the provided backing thread for catalog-backed transport", async () => {
    renderComposer("", {
      threadId: "draft:topLeft",
      transportThreadId: "thread-2",
    });

    await waitFor(() => {
      expect(mockedBridge.getThreadComposerCatalog).toHaveBeenCalledWith(
        "thread-2",
      );
    });
  });

  it("applies a completed transcript after returning to the owner thread", async () => {
    const transcription = createDeferred<{ text: string }>();
    mockedStartVoiceCapture.mockResolvedValue(makeCapture());
    mockedBridge.transcribeEnvironmentVoice.mockReturnValue(transcription.promise);

    renderComposerWithDynamicThread("Plan:");

    const startButton = await screen.findByRole("button", {
      name: "Start voice dictation",
    });
    await waitFor(() => {
      expect(startButton).toBeEnabled();
    });

    await userEvent.click(startButton);
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop voice dictation" }),
    );

    await waitFor(() => {
      expect(mockedBridge.transcribeEnvironmentVoice).toHaveBeenCalledTimes(1);
    });

    await userEvent.click(screen.getByRole("button", { name: "Switch to thread 2" }));
    transcription.resolve({ text: "voice note" });
    expect(screen.getByPlaceholderText("Message Skein...")).toHaveValue("");

    await userEvent.click(screen.getByRole("button", { name: "Switch to thread 1" }));

    expect(
      await screen.findByDisplayValue("Plan: voice note"),
    ).toBeInTheDocument();
  });
});

describe("InlineComposer image attachments", () => {
  it("sends image-only drafts with attached files", async () => {
    const onSend = vi.fn();
    vi.mocked(open).mockResolvedValue(["/tmp/screenshot.png"]);

    renderComposer("", { onSend });

    await userEvent.click(
      await screen.findByRole("button", { name: "Attach images" }),
    );

    await waitFor(() => {
      expect(screen.getByText("screenshot.png")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith("", [
      { type: "localImage", path: "/tmp/screenshot.png" },
    ], [], []);
  });

  it("ignores picker failures and keeps the composer usable", async () => {
    const onSend = vi.fn();
    vi.mocked(open).mockRejectedValue(new Error("dialog failed"));

    renderComposer("Retry after picker failure", { onSend });

    await userEvent.click(
      await screen.findByRole("button", { name: "Attach images" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith(
      "Retry after picker failure",
      [],
      [],
      [],
    );
    expect(screen.queryByLabelText("Attached images")).toBeNull();
  });

  it("keeps successful pasted images when one file read fails", async () => {
    const originalFileReader = window.FileReader;
    class FakeFileReader {
      public result: string | ArrayBuffer | null = null;
      public error: DOMException | null = null;
      public onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      public onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

      readAsDataURL(file: File) {
        queueMicrotask(() => {
          if (file.name === "broken.png") {
            this.error = new DOMException("failed");
            this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>);
            return;
          }
          this.result = "data:image/png;base64,c3VjY2Vzcw==";
          this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
        });
      }
    }

    Object.defineProperty(window, "FileReader", {
      configurable: true,
      value: FakeFileReader,
    });

    try {
      renderComposer("");

      const input = await screen.findByPlaceholderText("Message Skein...");
      fireEvent.paste(input, {
        clipboardData: {
          items: [
            {
              kind: "file",
              getAsFile: () =>
                new File(["ok"], "success.png", { type: "image/png" }),
            },
            {
              kind: "file",
              getAsFile: () =>
                new File(["nope"], "broken.png", { type: "image/png" }),
            },
          ],
        },
      });

      await waitFor(() => {
        expect(screen.getAllByText("Pasted image")).toHaveLength(1);
      });
    } finally {
      Object.defineProperty(window, "FileReader", {
        configurable: true,
        value: originalFileReader,
      });
    }
  });

  it("ignores async image completions after the composer becomes disabled", async () => {
    const originalFileReader = window.FileReader;
    let completeRead: (() => void) | null = null;

    class DeferredFileReader {
      public result: string | ArrayBuffer | null = null;
      public error: DOMException | null = null;
      public onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      public onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

      readAsDataURL() {
        completeRead = () => {
          this.result = "data:image/png;base64,c3VjY2Vzcw==";
          this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
        };
      }
    }

    Object.defineProperty(window, "FileReader", {
      configurable: true,
      value: DeferredFileReader,
    });

    try {
      renderComposerWithDynamicDisabledState("");

      const input = await screen.findByPlaceholderText("Message Skein...");
      fireEvent.paste(input, {
        clipboardData: {
          items: [
            {
              kind: "file",
              getAsFile: () =>
                new File(["ok"], "success.png", { type: "image/png" }),
            },
          ],
        },
      });

      await userEvent.click(
        screen.getByRole("button", { name: "Disable composer" }),
      );

      await act(async () => {
        completeRead?.();
      });

      await waitFor(() => {
        expect(screen.queryByLabelText("Attached images")).toBeNull();
      });
    } finally {
      Object.defineProperty(window, "FileReader", {
        configurable: true,
        value: originalFileReader,
      });
    }
  });

  it("disables image attachments when the selected model lacks image input", async () => {
    renderComposer("", {
      modelOptions: [
        {
          ...capabilitiesFixture.models[0],
          inputModalities: ["text"],
        },
      ],
    });

    const attachButton = await screen.findByRole("button", {
      name: "Attach images",
    });
    expect(attachButton).toBeDisabled();
    expect(
      screen.getByText(
        "Image attachments are unavailable for GPT-5.4.",
      ),
    ).toBeInTheDocument();
  });

  it("toggles fast mode from the lightning control", async () => {
    const onUpdateComposer = vi.fn();
    renderComposer("", { onUpdateComposer });

    await userEvent.click(
      await screen.findByRole("button", { name: /Fast mode is off/i }),
    );

    expect(onUpdateComposer).toHaveBeenCalledWith({ serviceTier: "fast" });
  });

  it("disables fast mode when the selected model does not support it", async () => {
    renderComposer("", {
      modelOptions: [
        {
          ...capabilitiesFixture.models[0],
          supportedServiceTiers: [],
        },
      ],
    });

    const fastButton = await screen.findByRole("button", {
      name: /Fast mode is unavailable/i,
    });
    expect(fastButton).toBeDisabled();
  });

  it("restores a prior flex tier when fast mode is toggled back off", async () => {
    renderComposerWithManagedServiceTier("flex");

    const fastButton = await screen.findByRole("button", {
      name: /Fast mode is off/i,
    });

    await userEvent.click(fastButton);
    expect(screen.getByTestId("service-tier")).toHaveTextContent("fast");

    await userEvent.click(
      await screen.findByRole("button", { name: /Fast mode is on/i }),
    );
    expect(screen.getByTestId("service-tier")).toHaveTextContent("flex");
  });
});

function renderComposer(
  initialDraft: string,
  options: {
    composer?: ComponentProps<typeof InlineComposer>["composer"];
    disabled?: boolean;
    modelOptions?: typeof capabilitiesFixture.models;
    onSend?: ComponentProps<typeof InlineComposer>["onSend"];
    onUpdateComposer?: ComponentProps<typeof InlineComposer>["onUpdateComposer"];
    threadId?: string;
    transportEnabled?: boolean;
    transportThreadId?: string | null;
    voiceEnabled?: boolean;
  } = {},
) {
  function Harness() {
    const [draft, setDraft] = useState(initialDraft);
    const [images, setImages] = useState<
      Array<
        { type: "image"; url: string } | { type: "localImage"; path: string }
      >
    >([]);
    const [mentionBindings, setMentionBindings] = useState<
      ComposerDraftMentionBinding[]
    >([]);

    return (
      <InlineComposer
        environmentId="env-1"
        threadId={options.threadId ?? "thread-1"}
        composer={options.composer ?? baseComposer}
        collaborationModes={capabilitiesFixture.collaborationModes}
        disabled={options.disabled ?? false}
        draft={draft}
        effortOptions={["low", "medium", "high", "xhigh"]}
        focusKey="thread-1"
        images={images}
        isBusy={false}
        isSending={false}
        isRefiningPlan={false}
        mentionBindings={mentionBindings}
        modelOptions={options.modelOptions ?? capabilitiesFixture.models}
        onChangeImages={setImages}
        tokenUsage={null}
        onCancelRefine={() => undefined}
        onChangeDraft={setDraft}
        onChangeMentionBindings={setMentionBindings}
        onInterrupt={() => undefined}
        onSend={(...args) => options.onSend?.(...args)}
        onUpdateComposer={(patch) => options.onUpdateComposer?.(patch)}
        transportEnabled={options.transportEnabled}
        transportThreadId={options.transportThreadId}
        voiceEnabled={options.voiceEnabled}
      />
    );
  }

  return render(<Harness />);
}

function renderComposerWithExternalDraftAction(initialDraft: string) {
  function Harness() {
    const [draft, setDraft] = useState(initialDraft);
    const [images, setImages] = useState<
      Array<
        { type: "image"; url: string } | { type: "localImage"; path: string }
      >
    >([]);
    const [mentionBindings, setMentionBindings] = useState<
      ComposerDraftMentionBinding[]
    >([]);

    return (
      <>
        <button
          type="button"
          aria-label="Set draft externally"
          onClick={() => setDraft("Edited while transcribing")}
        >
          Set draft externally
        </button>
        <InlineComposer
          environmentId="env-1"
          threadId="thread-1"
          composer={baseComposer}
          collaborationModes={capabilitiesFixture.collaborationModes}
          disabled={false}
          draft={draft}
          effortOptions={["low", "medium", "high", "xhigh"]}
          focusKey="thread-1"
          images={images}
          isBusy={false}
          isSending={false}
          isRefiningPlan={false}
          mentionBindings={mentionBindings}
          modelOptions={capabilitiesFixture.models}
          onChangeImages={setImages}
          tokenUsage={null}
          onCancelRefine={() => undefined}
          onChangeDraft={setDraft}
          onChangeMentionBindings={setMentionBindings}
          onInterrupt={() => undefined}
          onSend={() => undefined}
          onUpdateComposer={() => undefined}
        />
      </>
    );
  }

  return render(<Harness />);
}

function renderComposerWithManagedServiceTier(initialServiceTier: "fast" | "flex") {
  function Harness() {
    const [composer, setComposer] = useState<
      ComponentProps<typeof InlineComposer>["composer"]
    >({
      ...baseComposer,
      serviceTier: initialServiceTier,
    });
    const [draft, setDraft] = useState("");
    const [images, setImages] = useState<
      Array<
        { type: "image"; url: string } | { type: "localImage"; path: string }
      >
    >([]);
    const [mentionBindings, setMentionBindings] = useState<
      ComposerDraftMentionBinding[]
    >([]);

    return (
      <>
        <output data-testid="service-tier">
          {composer.serviceTier ?? "none"}
        </output>
        <InlineComposer
          environmentId="env-1"
          threadId="thread-1"
          composer={composer}
          collaborationModes={capabilitiesFixture.collaborationModes}
          disabled={false}
          draft={draft}
          effortOptions={["low", "medium", "high", "xhigh"]}
          focusKey="thread-1"
          images={images}
          isBusy={false}
          isSending={false}
          isRefiningPlan={false}
          mentionBindings={mentionBindings}
          modelOptions={capabilitiesFixture.models}
          onChangeImages={setImages}
          tokenUsage={null}
          onCancelRefine={() => undefined}
          onChangeDraft={setDraft}
          onChangeMentionBindings={setMentionBindings}
          onInterrupt={() => undefined}
          onSend={() => undefined}
          onUpdateComposer={(patch) =>
            setComposer((currentComposer) => ({
              ...currentComposer,
              ...patch,
            }))
          }
        />
      </>
    );
  }

  return render(<Harness />);
}

function renderComposerWithDynamicDisabledState(initialDraft: string) {
  function Harness() {
    const [draft, setDraft] = useState(initialDraft);
    const [images, setImages] = useState<
      Array<
        { type: "image"; url: string } | { type: "localImage"; path: string }
      >
    >([]);
    const [mentionBindings, setMentionBindings] = useState<
      ComposerDraftMentionBinding[]
    >([]);
    const [disabled, setDisabled] = useState(false);

    return (
      <>
        <button type="button" onClick={() => setDisabled(true)}>
          Disable composer
        </button>
        <InlineComposer
          environmentId="env-1"
          threadId="thread-1"
          composer={baseComposer}
          collaborationModes={capabilitiesFixture.collaborationModes}
          disabled={disabled}
          draft={draft}
          effortOptions={["low", "medium", "high", "xhigh"]}
          focusKey="thread-1"
          images={images}
          isBusy={false}
          isSending={false}
          isRefiningPlan={false}
          mentionBindings={mentionBindings}
          modelOptions={capabilitiesFixture.models}
          onChangeImages={setImages}
          tokenUsage={null}
          onCancelRefine={() => undefined}
          onChangeDraft={setDraft}
          onChangeMentionBindings={setMentionBindings}
          onInterrupt={() => undefined}
          onSend={() => undefined}
          onUpdateComposer={() => undefined}
        />
      </>
    );
  }

  return render(<Harness />);
}

function renderComposerWithDynamicThread(initialDraft: string) {
  function Harness() {
    const [draftByThreadId, setDraftByThreadId] = useState<
      Record<string, string>
    >({
      "thread-1": initialDraft,
      "thread-2": "",
    });
    const [images, setImages] = useState<
      Array<
        { type: "image"; url: string } | { type: "localImage"; path: string }
      >
    >([]);
    const [mentionBindings, setMentionBindings] = useState<
      ComposerDraftMentionBinding[]
    >([]);
    const [threadId, setThreadId] = useState("thread-1");
    const draft = draftByThreadId[threadId] ?? "";

    return (
      <>
        <button type="button" onClick={() => setThreadId("thread-1")}>
          Switch to thread 1
        </button>
        <button type="button" onClick={() => setThreadId("thread-2")}>
          Switch to thread 2
        </button>
        <InlineComposer
          environmentId="env-1"
          threadId={threadId}
          composer={baseComposer}
          collaborationModes={capabilitiesFixture.collaborationModes}
          disabled={false}
          draft={draft}
          effortOptions={["low", "medium", "high", "xhigh"]}
          focusKey={threadId}
          images={images}
          isBusy={false}
          isSending={false}
          isRefiningPlan={false}
          mentionBindings={mentionBindings}
          modelOptions={capabilitiesFixture.models}
          onChangeImages={setImages}
          tokenUsage={null}
          onCancelRefine={() => undefined}
          onChangeDraft={(value) =>
            setDraftByThreadId((state) => ({
              ...state,
              [threadId]: value,
            }))
          }
          onChangeMentionBindings={setMentionBindings}
          onInterrupt={() => undefined}
          onSend={() => undefined}
          onUpdateComposer={() => undefined}
        />
      </>
    );
  }

  return render(<Harness />);
}

function renderComposerWithDynamicTransport(initialDraft: string) {
  function Harness() {
    const [draft, setDraft] = useState(initialDraft);
    const [images, setImages] = useState<
      Array<
        { type: "image"; url: string } | { type: "localImage"; path: string }
      >
    >([]);
    const [mentionBindings, setMentionBindings] = useState<
      ComposerDraftMentionBinding[]
    >([]);
    const [transportEnabled, setTransportEnabled] = useState(true);

    return (
      <>
        <button type="button" onClick={() => setTransportEnabled(false)}>
          Disable transport
        </button>
        <InlineComposer
          environmentId="env-1"
          threadId="thread-1"
          composer={baseComposer}
          collaborationModes={capabilitiesFixture.collaborationModes}
          disabled={false}
          draft={draft}
          effortOptions={["low", "medium", "high", "xhigh"]}
          focusKey="thread-1"
          images={images}
          isBusy={false}
          isSending={false}
          isRefiningPlan={false}
          mentionBindings={mentionBindings}
          modelOptions={capabilitiesFixture.models}
          onChangeImages={setImages}
          tokenUsage={null}
          onCancelRefine={() => undefined}
          onChangeDraft={setDraft}
          onChangeMentionBindings={setMentionBindings}
          onInterrupt={() => undefined}
          onSend={() => undefined}
          onUpdateComposer={() => undefined}
          transportEnabled={transportEnabled}
        />
      </>
    );
  }

  return render(<Harness />);
}

function makeCapture() {
  return {
    cancel: vi.fn(async () => undefined),
    stop: vi.fn(async () => ({
      audioBase64: "dGVzdA==",
      durationMs: 1_200,
      mimeType: "audio/wav" as const,
      sampleRateHz: 24_000 as const,
    })),
  };
}
