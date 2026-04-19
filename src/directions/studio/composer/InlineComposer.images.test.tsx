import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";

import * as bridge from "../../../lib/bridge";
import type { ComposerDraftMentionBinding } from "../../../lib/types";
import {
  baseComposer,
  capabilitiesFixture,
} from "../../../test/fixtures/conversation";
import { resetVoiceSessionStore } from "../../../stores/voice-session-store";
import { useVoiceStatusStore } from "../../../stores/voice-status-store";
import {
  MAX_CONVERSATION_IMAGE_BYTES,
} from "../conversation-images";
import { InlineComposer } from "./InlineComposer";

vi.mock("../../../lib/bridge", () => ({
  getComposerCatalog: vi.fn(),
  searchComposerFiles: vi.fn(),
  getEnvironmentVoiceStatus: vi.fn(),
  transcribeEnvironmentVoice: vi.fn(),
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
  useVoiceStatusStore.setState((state) => ({
    ...state,
    snapshotsByEnvironmentId: {},
    loadingByEnvironmentId: {},
    errorByEnvironmentId: {},
    lastFetchedAtByEnvironmentId: {},
    lastRequestedAtByEnvironmentId: {},
  }));
  mockedBridge.getComposerCatalog.mockResolvedValue({
    prompts: [],
    skills: [],
    apps: [],
  });
  mockedBridge.searchComposerFiles.mockResolvedValue([]);
  mockedBridge.getEnvironmentVoiceStatus.mockResolvedValue({
    environmentId: "env-1",
    available: true,
    authMode: "chatgpt",
    unavailableReason: null,
    message: null,
  });
  vi.mocked(open).mockResolvedValue(null);
});

describe("InlineComposer image regressions", () => {
  it("ignores async picker completions after switching threads", async () => {
    const selection = createDeferred<string | string[] | null>();
    vi.mocked(open).mockReturnValue(selection.promise);

    renderComposerWithDynamicThreadState();

    await userEvent.click(
      await screen.findByRole("button", { name: "Attach images" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Switch threads" }),
    );

    selection.resolve(["/tmp/thread-a.png"]);

    await waitFor(() => {
      expect(screen.queryByText("thread-a.png")).toBeNull();
    });
  });

  it("ignores async pasted image completions after switching threads", async () => {
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
      renderComposerWithDynamicThreadState();

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
        screen.getByRole("button", { name: "Switch threads" }),
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

  it("skips oversized pasted images before reading them", async () => {
    const originalFileReader = window.FileReader;
    const readAsDataUrl = vi.fn();

    class TrackingFileReader {
      public result: string | ArrayBuffer | null = null;
      public error: DOMException | null = null;
      public onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      public onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

      readAsDataURL(file: File) {
        readAsDataUrl(file);
      }
    }

    Object.defineProperty(window, "FileReader", {
      configurable: true,
      value: TrackingFileReader,
    });

    try {
      renderComposer();

      const oversized = new File(["x"], "huge.png", { type: "image/png" });
      Object.defineProperty(oversized, "size", {
        configurable: true,
        value: MAX_CONVERSATION_IMAGE_BYTES + 1,
      });

      fireEvent.paste(await screen.findByPlaceholderText("Message Skein..."), {
        clipboardData: {
          items: [
            {
              kind: "file",
              getAsFile: () => oversized,
            },
          ],
        },
      });

      await waitFor(() => {
        expect(screen.queryByLabelText("Attached images")).toBeNull();
      });
      expect(readAsDataUrl).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "FileReader", {
        configurable: true,
        value: originalFileReader,
      });
    }
  });

  it("fails closed when the selected model is missing from the capability list", async () => {
    renderComposer({ modelOptions: [] });

    const attachButton = await screen.findByRole("button", {
      name: "Attach images",
    });
    expect(attachButton).toBeDisabled();
    expect(
      screen.getByText(
        "Image attachments are unavailable for the selected model.",
      ),
    ).toBeInTheDocument();
  });
});

function renderComposer(options: {
  modelOptions?: typeof capabilitiesFixture.models;
} = {}) {
  function Harness() {
    const [draft, setDraft] = useState("");
    const [images, setImages] = useState<
      Array<
        { type: "image"; url: string } | { type: "localImage"; path: string }
      >
    >([]);
    const [mentionBindings, setMentionBindings] = useState<
      ComposerDraftMentionBinding[]
    >([]);
    const composerTarget = useMemo(
      () => ({ kind: "thread" as const, threadId: "thread-1" }),
      [],
    );

    return (
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
        modelOptions={options.modelOptions ?? capabilitiesFixture.models}
        onChangeImages={setImages}
        tokenUsage={null}
        onCancelRefine={() => undefined}
        onChangeDraft={setDraft}
        onChangeMentionBindings={setMentionBindings}
        onInterrupt={() => undefined}
        onSend={() => undefined}
        onUpdateComposer={() => undefined}
        catalogTarget={composerTarget}
        fileSearchTarget={composerTarget}
      />
    );
  }

  return render(<Harness />);
}

function renderComposerWithDynamicThreadState() {
  function Harness() {
    const [draft, setDraft] = useState("");
    const [images, setImages] = useState<
      Array<
        { type: "image"; url: string } | { type: "localImage"; path: string }
      >
    >([]);
    const [mentionBindings, setMentionBindings] = useState<
      ComposerDraftMentionBinding[]
    >([]);
    const [threadId, setThreadId] = useState("thread-1");
    const composerTarget = useMemo(
      () => ({ kind: "thread" as const, threadId }),
      [threadId],
    );

    useEffect(() => {
      setImages([]);
    }, [threadId]);

    return (
      <>
        <button type="button" onClick={() => setThreadId("thread-2")}>
          Switch threads
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
          onChangeDraft={setDraft}
          onChangeMentionBindings={setMentionBindings}
          onInterrupt={() => undefined}
          onSend={() => undefined}
          onUpdateComposer={() => undefined}
          catalogTarget={composerTarget}
          fileSearchTarget={composerTarget}
        />
      </>
    );
  }

  return render(<Harness />);
}
