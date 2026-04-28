import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { getComposerCatalog, searchComposerFiles } from "../../../lib/bridge";
import { APP_NAME } from "../../../lib/app-identity";
import type {
  ComposerDraftMentionBinding,
  ComposerMentionBindingInput,
  ComposerFileSearchResult,
  ComposerTarget,
  ConversationComposerSettings,
  ConversationImageAttachment,
  ModelOption,
  ReasoningEffort,
  ThreadComposerCatalog,
} from "../../../lib/types";
import {
  ArrowUpIcon,
  BoltIcon,
  CloseIcon,
  ImageIcon,
  MapIcon,
  MicIcon,
  StopIcon,
} from "../../../shared/Icons";
import { Tooltip } from "../../../shared/Tooltip";
import { ComposerPicker } from "../ComposerPicker";
import {
  modelImageSupportMessage,
  modelSupportsFastMode,
  modelSupportsImageInput,
} from "../conversation-images";
import {
  APPROVAL_OPTIONS,
  labelForCollaborationMode,
  reasoningOptionsFor,
} from "../composerOptions";
import { formatModelLabel, labelForModelOption } from "../modelLabels";
import { ComposerAutocompleteMenu } from "./ComposerAutocompleteMenu";
import { ComposerImageStrip } from "./ComposerImageStrip";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ReasoningContextPicker } from "./ReasoningContextPicker";
import {
  addComposerMentionBinding,
  prepareComposerMentionBindingsForSend,
  rebaseComposerMentionBindings,
  sameComposerMentionBindings,
} from "./composer-mention-bindings";
import { ComposerTextMirror } from "./ComposerTextMirror";
import {
  buildAutocompleteItems,
  findActiveComposerToken,
  replaceComposerToken,
  type ComposerAutocompleteItem,
} from "./composer-model";
import { formatVoiceDuration } from "./voice-duration";
import { useComposerImageInput } from "./useComposerImageInput";
import { useComposerVoiceInput } from "./useComposerVoiceInput";
import "./ComposerVoice.css";

type Props = {
  environmentId: string;
  threadId: string;
  composer: ConversationComposerSettings;
  collaborationModes: Array<{ id: string; label: string }>;
  disabled: boolean;
  draft: string;
  effortOptions: ReasoningEffort[];
  focusKey: string;
  images: ConversationImageAttachment[];
  isBusy: boolean;
  isSending: boolean;
  isRefiningPlan: boolean;
  mentionBindings: ComposerDraftMentionBinding[];
  modelOptions: ModelOption[];
  onChangeImages: Dispatch<SetStateAction<ConversationImageAttachment[]>>;
  onCancelRefine: () => void;
  onChangeDraft: (
    value: string,
    bindings?: ComposerDraftMentionBinding[],
  ) => void;
  onChangeMentionBindings: (bindings: ComposerDraftMentionBinding[]) => void;
  onInterrupt: () => void;
  onSend: (
    text: string,
    images: ConversationImageAttachment[],
    mentionBindings: ComposerMentionBindingInput[],
    draftMentionBindings: ComposerDraftMentionBinding[],
  ) => void;
  onUpdateComposer: (patch: Partial<ConversationComposerSettings>) => void;
  catalogTarget?: ComposerTarget | null;
  catalogRefreshKey?: string | null;
  fileSearchTarget?: ComposerTarget | null;
  imageSupportNoticeEnabled?: boolean;
  transportEnabled?: boolean;
  voiceEnabled?: boolean;
  providerLocked?: boolean;
};

export function InlineComposer({
  environmentId,
  threadId,
  composer,
  collaborationModes,
  disabled,
  draft,
  effortOptions,
  focusKey,
  images,
  isBusy,
  isSending,
  isRefiningPlan,
  mentionBindings,
  modelOptions,
  onChangeImages,
  onCancelRefine,
  onChangeDraft,
  onChangeMentionBindings,
  onInterrupt,
  onSend,
  onUpdateComposer,
  catalogTarget = null,
  catalogRefreshKey = null,
  fileSearchTarget = null,
  imageSupportNoticeEnabled,
  transportEnabled = true,
  voiceEnabled = transportEnabled,
  providerLocked = true,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileSearchRequestRef = useRef(0);
  const previousDraftRef = useRef(draft);
  const previousThreadIdRef = useRef(threadId);
  const lastNonFastServiceTierRef = useRef<
    ConversationComposerSettings["serviceTier"]
  >(composer.serviceTier === "fast" ? null : (composer.serviceTier ?? null));
  const [catalog, setCatalog] = useState<ThreadComposerCatalog | null>(null);
  const [fileResults, setFileResults] = useState<ComposerFileSearchResult[]>(
    [],
  );
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedTokenKey, setDismissedTokenKey] = useState<string | null>(
    null,
  );
  const [pendingCursor, setPendingCursor] = useState<number | null>(null);
  const isPlanMode = composer.collaborationMode === "plan";
  const nextMode: ConversationComposerSettings["collaborationMode"] = isPlanMode
    ? "build"
    : "plan";
  const canToggleMode = collaborationModes.some(
    (option) => option.id === nextMode,
  );
  const baseInputDisabled =
    isBusy || isSending || (disabled && !isRefiningPlan);
  const baseControlsDisabled = isBusy || isSending || disabled;
  const placeholder = isRefiningPlan
    ? "Refine the proposed plan..."
    : `Message ${APP_NAME}...`;
  const selectedModel = useMemo(
    () =>
      modelOptions.find(
        (candidate) =>
          candidate.id === composer.model &&
          (candidate.provider ?? "codex") === composer.provider,
      ) ?? null,
    [composer.model, composer.provider, modelOptions],
  );
  const effectiveEffortOptions =
    selectedModel?.supportedReasoningEfforts ?? effortOptions;
  const fastModeSupported = modelSupportsFastMode(selectedModel);
  const fastModeEnabled = fastModeSupported && composer.serviceTier === "fast";
  const selectedModelLabel = selectedModel
    ? labelForModelOption(selectedModel, composer.model)
    : formatModelLabel(composer.model);
  const selectedModelUnavailable =
    modelOptions.length > 0 && selectedModel === null;
  let fastModeLabel: string;
  if (!fastModeSupported) {
    fastModeLabel = `Fast mode is unavailable for ${selectedModelLabel}.`;
  } else if (fastModeEnabled) {
    fastModeLabel = "Fast mode is on. Faster responses use more quota.";
  } else {
    fastModeLabel =
      "Fast mode is off. Enable faster responses at higher quota usage.";
  }
  const imagesEnabled = modelSupportsImageInput(selectedModel);
  const hasAttachedImages = images.length > 0;
  const hasDraftContent = draft.trim().length > 0;
  const showImageSupportNotice = imageSupportNoticeEnabled ?? transportEnabled;
  let imageSupportNotice: string | null = null;
  if (selectedModelUnavailable) {
    imageSupportNotice = `${selectedModelLabel} is unavailable for the active runtime. Switch to an available model.`;
  } else if (!imagesEnabled && showImageSupportNotice) {
    const base = modelImageSupportMessage(selectedModel);
    imageSupportNotice = hasAttachedImages
      ? `${base} Remove the current images or switch to a model with image input.`
      : base;
  }
  const {
    buttonDisabled: voiceButtonDisabled,
    buttonLabel: voiceButtonLabel,
    buttonTitle: voiceButtonTitle,
    errorMessage: voiceErrorMessage,
    isRecording,
    isStarting,
    isTranscribing,
    onDismissError,
    onVoiceButtonClick,
    voiceBusy,
    voiceDurationMs,
  } = useComposerVoiceInput({
    currentDraft: draft,
    enabled: voiceEnabled,
    environmentId,
    inputRef: textareaRef,
    locked: baseControlsDisabled,
    onChangeDraft,
    threadId,
  });
  const voiceDurationLabel = formatVoiceDuration(voiceDurationMs);
  const voiceButtonClassName = [
    "tx-composer__voice-button",
    isRecording ? "tx-composer__voice-button--recording" : null,
    isStarting || isTranscribing ? "tx-composer__voice-button--busy" : null,
  ]
    .filter(Boolean)
    .join(" ");
  let voiceLiveStatus = "";
  if (isRecording) {
    voiceLiveStatus = "Recording voice dictation";
  } else if (isStarting) {
    voiceLiveStatus = "Starting voice dictation";
  } else if (isTranscribing) {
    voiceLiveStatus = "Transcribing voice dictation";
  }
  const inputDisabled = baseInputDisabled || voiceBusy;
  const controlsDisabled = baseControlsDisabled || voiceBusy;
  const missingRequiredContent = isRefiningPlan
    ? !hasDraftContent
    : !hasDraftContent && !hasAttachedImages;
  const sendDisabled =
    inputDisabled ||
    selectedModelUnavailable ||
    missingRequiredContent ||
    (hasAttachedImages && !imagesEnabled);
  const {
    dropTargetRef,
    isDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handlePaste,
    pickImages,
    removeImage,
  } = useComposerImageInput({
    disabled: inputDisabled,
    imagesEnabled,
    scopeKey: threadId,
    setImages: onChangeImages,
  });

  useEffect(() => {
    if (!catalogTarget) {
      setCatalog(null);
      return;
    }

    let cancelled = false;
    setCatalog(null);
    void getComposerCatalog(catalogTarget)
      .then((nextCatalog) => {
        if (!cancelled) {
          setCatalog(nextCatalog);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalogRefreshKey, catalogTarget]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element || element.disabled) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      element.focus();
      setSelection({
        start: element.selectionStart ?? 0,
        end: element.selectionEnd ?? 0,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusKey]);

  const activeToken = useMemo(
    () => findActiveComposerToken(draft, selection.start, selection.end),
    [draft, selection.end, selection.start],
  );
  const activeTokenKey = activeToken
    ? `${activeToken.kind}:${activeToken.start}:${activeToken.raw}`
    : null;

  useEffect(() => {
    if (activeTokenKey !== dismissedTokenKey) {
      setDismissedTokenKey(null);
    }
  }, [activeTokenKey, dismissedTokenKey]);

  useEffect(() => {
    if (previousThreadIdRef.current !== threadId) {
      previousThreadIdRef.current = threadId;
      previousDraftRef.current = draft;
      lastNonFastServiceTierRef.current =
        composer.serviceTier === "fast" ? null : (composer.serviceTier ?? null);
      setDismissedTokenKey(null);
    }
  }, [composer.serviceTier, draft, threadId]);

  useEffect(() => {
    if (composer.serviceTier !== "fast") {
      lastNonFastServiceTierRef.current = composer.serviceTier ?? null;
    }
  }, [composer.serviceTier]);

  useEffect(() => {
    if (previousDraftRef.current === draft) {
      return;
    }
    const nextMentionBindings = rebaseComposerMentionBindings(
      previousDraftRef.current,
      draft,
      mentionBindings,
    );
    previousDraftRef.current = draft;
    if (sameComposerMentionBindings(nextMentionBindings, mentionBindings)) {
      return;
    }
    onChangeMentionBindings(nextMentionBindings);
  }, [draft, mentionBindings, onChangeMentionBindings]);

  useEffect(() => {
    if (!fileSearchTarget) {
      fileSearchRequestRef.current += 1;
      setFileResults([]);
      return;
    }
    if (!activeToken || activeToken.kind !== "file") {
      fileSearchRequestRef.current += 1;
      setFileResults([]);
      return;
    }
    const requestId = fileSearchRequestRef.current + 1;
    fileSearchRequestRef.current = requestId;
    const timeout = window.setTimeout(() => {
      void searchComposerFiles({
        target: fileSearchTarget,
        requestKey: threadId,
        query: activeToken.query,
        limit: 50,
      })
        .then((results) => {
          if (fileSearchRequestRef.current === requestId) {
            setFileResults(results);
          }
        })
        .catch(() => {
          if (fileSearchRequestRef.current === requestId) {
            setFileResults([]);
          }
        });
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [activeToken, fileSearchTarget, threadId]);

  const autocompleteItems = useMemo(
    () =>
      dismissedTokenKey === activeTokenKey
        ? []
        : buildAutocompleteItems(
            activeToken,
            catalog,
            fileResults.map((result) => result.path),
            composer.provider,
          ),
    [
      activeToken,
      activeTokenKey,
      catalog,
      composer.provider,
      dismissedTokenKey,
      fileResults,
    ],
  );
  const hasAutocompleteItems = autocompleteItems.length > 0;

  useEffect(() => {
    setActiveIndex((current) =>
      autocompleteItems.length === 0
        ? 0
        : Math.min(current, autocompleteItems.length - 1),
    );
  }, [autocompleteItems.length]);

  useEffect(() => {
    if (!menuRef.current) {
      return;
    }
    const active = menuRef.current.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    );
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, autocompleteItems]);

  useLayoutEffect(() => {
    if (pendingCursor === null) {
      return;
    }
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    element.focus();
    element.setSelectionRange(pendingCursor, pendingCursor);
    setSelection({ start: pendingCursor, end: pendingCursor });
    setPendingCursor(null);
  }, [draft, pendingCursor]);

  function syncSelection() {
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    setSelection({
      start: element.selectionStart ?? 0,
      end: element.selectionEnd ?? 0,
    });
  }

  function applyItem(item: ComposerAutocompleteItem) {
    if (!activeToken) {
      return;
    }
    const replacement = replaceComposerToken(draft, activeToken, item);
    const rebasedBindings = rebaseComposerMentionBindings(
      draft,
      replacement.text,
      mentionBindings,
    );
    const nextBindings = addComposerMentionBinding(
      rebasedBindings,
      item,
      activeToken.start,
    );
    previousDraftRef.current = replacement.text;
    onChangeDraft(replacement.text, nextBindings);
    setPendingCursor(replacement.cursor);
    setDismissedTokenKey(null);
  }

  function sendDraft() {
    if (sendDisabled) {
      return;
    }
    onSend(
      draft,
      images,
      prepareComposerMentionBindingsForSend(draft, mentionBindings),
      mentionBindings,
    );
  }

  function collaborationModeLabel(
    mode: ConversationComposerSettings["collaborationMode"],
  ) {
    return (
      collaborationModes.find((option) => option.id === mode)?.label ??
      labelForCollaborationMode(mode)
    );
  }

  const currentModeLabel = collaborationModeLabel(composer.collaborationMode);
  const nextModeLabel = collaborationModeLabel(nextMode);

  return (
    <div className={`tx-composer ${isPlanMode ? "tx-composer--plan" : ""}`}>
      <div className="tx-composer__menu-anchor">
        {hasAutocompleteItems ? (
          <div ref={menuRef} className="tx-composer__menu-portal">
            <ComposerAutocompleteMenu
              items={autocompleteItems}
              activeIndex={activeIndex}
              onSelect={applyItem}
            />
          </div>
        ) : null}
      </div>

      <div
        ref={dropTargetRef}
        className="tx-composer__body"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={(event) => void handleDrop(event)}
      >
        <ComposerImageStrip
          disabled={inputDisabled}
          images={images}
          onRemove={removeImage}
        />
        {imageSupportNotice ? (
          <div className="tx-composer__notice">{imageSupportNotice}</div>
        ) : null}
        <div
          className={[
            "tx-inline-composer",
            inputDisabled ? "tx-inline-composer--disabled" : null,
            isDragOver ? "tx-inline-composer--drag-over" : null,
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <ComposerTextMirror
            draft={draft}
            catalog={catalog}
            placeholder={placeholder}
            provider={composer.provider}
            scrollTop={scrollTop}
          />
          <textarea
            ref={textareaRef}
            className="tx-inline-composer__textarea"
            rows={1}
            value={draft}
            aria-label={
              isRefiningPlan
                ? "Refine the proposed plan"
                : `Message ${APP_NAME}`
            }
            placeholder={placeholder}
            disabled={inputDisabled}
            onChange={(event) => {
              const nextDraft = event.target.value;
              const nextBindings = rebaseComposerMentionBindings(
                previousDraftRef.current,
                nextDraft,
                mentionBindings,
              );
              previousDraftRef.current = nextDraft;
              onChangeDraft(nextDraft, nextBindings);
              setSelection({
                start: event.target.selectionStart ?? 0,
                end: event.target.selectionEnd ?? 0,
              });
              setDismissedTokenKey(null);
            }}
            onClick={syncSelection}
            onKeyUp={syncSelection}
            onPaste={(event) => void handlePaste(event)}
            onSelect={syncSelection}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return;
              }
              if (hasAutocompleteItems) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex(
                    (current) => (current + 1) % autocompleteItems.length,
                  );
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((current) =>
                    current === 0 ? autocompleteItems.length - 1 : current - 1,
                  );
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  applyItem(
                    autocompleteItems[activeIndex] ?? autocompleteItems[0],
                  );
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissedTokenKey(activeTokenKey);
                  return;
                }
              }

              if (event.key === "Escape" && isRefiningPlan) {
                event.preventDefault();
                onCancelRefine();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendDraft();
              }
            }}
          />
          {isDragOver ? (
            <div className="tx-inline-composer__drop-hint">
              Drop images to attach them to this message
            </div>
          ) : null}
        </div>
        {voiceErrorMessage ? (
          <div
            className="tx-composer__notice tx-composer__notice--voice-error"
            role="status"
            aria-live="polite"
          >
            <span className="tx-composer__notice-copy">
              <span className="tx-composer__notice-label">
                Voice transcription failed.
              </span>{" "}
              {voiceErrorMessage}
            </span>
            <button
              type="button"
              className="tx-composer__notice-dismiss"
              aria-label="Dismiss voice error"
              onClick={onDismissError}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        ) : null}
      </div>

      <div className="tx-composer__controls">
        <div className="tx-composer__controls-group">
          <Tooltip
            content={
              imagesEnabled
                ? "Attach images"
                : modelImageSupportMessage(selectedModel)
            }
          >
            <button
              type="button"
              className="tx-composer__attach-button"
              aria-label="Attach images"
              disabled={controlsDisabled || !imagesEnabled}
              onClick={() => void pickImages()}
            >
              <ImageIcon size={14} />
            </button>
          </Tooltip>
          <ProviderModelPicker
            composer={composer}
            disabled={controlsDisabled}
            modelOptions={modelOptions}
            providerLocked={providerLocked}
            onUpdateComposer={onUpdateComposer}
          />
          <ReasoningContextPicker
            composer={composer}
            disabled={controlsDisabled}
            modelOptions={modelOptions}
            options={reasoningOptionsFor(effectiveEffortOptions)}
            onUpdateComposer={onUpdateComposer}
          />
          <ComposerPicker
            label="Access"
            value={composer.approvalPolicy}
            tone={
              composer.approvalPolicy === "fullAccess" ? "warning" : "default"
            }
            options={APPROVAL_OPTIONS}
            compact
            disabled={controlsDisabled}
            onChange={(value) =>
              onUpdateComposer({
                approvalPolicy:
                  value as ConversationComposerSettings["approvalPolicy"],
              })
            }
          />
          <span className="tx-composer__controls-separator" />
          <Tooltip
            content={
              canToggleMode ? `Switch to ${nextModeLabel}` : currentModeLabel
            }
          >
            <button
              type="button"
              className={[
                "tx-composer__icon-toggle",
                isPlanMode ? "tx-composer__icon-toggle--active" : null,
              ]
                .filter(Boolean)
                .join(" ")}
              aria-label={
                canToggleMode
                  ? `Collaboration mode: ${currentModeLabel}. Switch to ${nextModeLabel}`
                  : `Collaboration mode: ${currentModeLabel}`
              }
              aria-pressed={isPlanMode}
              disabled={controlsDisabled || !canToggleMode}
              onClick={() => onUpdateComposer({ collaborationMode: nextMode })}
            >
              <MapIcon size={14} />
            </button>
          </Tooltip>
          <Tooltip content={fastModeLabel}>
            <button
              type="button"
              className={[
                "tx-composer__icon-toggle",
                fastModeEnabled ? "tx-composer__icon-toggle--active" : null,
              ]
                .filter(Boolean)
                .join(" ")}
              aria-label={fastModeLabel}
              aria-pressed={fastModeEnabled}
              disabled={controlsDisabled || !fastModeSupported}
              onClick={() =>
                onUpdateComposer({
                  serviceTier: fastModeEnabled
                    ? (lastNonFastServiceTierRef.current ?? null)
                    : "fast",
                })
              }
            >
              <BoltIcon size={14} />
            </button>
          </Tooltip>
        </div>
        <div className="tx-composer__controls-right">
          <div className="tx-composer__voice-control">
            {isRecording ? (
              <span className="tx-composer__voice-duration" aria-hidden="true">
                {voiceDurationLabel}
              </span>
            ) : null}
            <Tooltip content={voiceButtonTitle}>
              <span
                className="tx-composer__voice-button-anchor"
                title={voiceButtonTitle}
              >
                <button
                  type="button"
                  className={voiceButtonClassName}
                  aria-label={voiceButtonLabel}
                  disabled={voiceButtonDisabled}
                  onClick={onVoiceButtonClick}
                >
                  {isStarting || isTranscribing ? (
                    <span
                      className="tx-composer__voice-spinner"
                      aria-hidden="true"
                    />
                  ) : (
                    <MicIcon size={18} />
                  )}
                </button>
              </span>
            </Tooltip>
            <span
              className="tx-composer__voice-live-status"
              role="status"
              aria-live="polite"
            >
              {voiceLiveStatus}
            </span>
          </div>
          {isBusy ? (
            <button
              type="button"
              className="tx-composer__send-button tx-composer__send-button--secondary"
              aria-label="Stop generation"
              onClick={onInterrupt}
            >
              <StopIcon size={12} />
            </button>
          ) : (
            <button
              type="button"
              className="tx-composer__send-button"
              aria-label={isRefiningPlan ? "Refine plan" : "Send message"}
              disabled={sendDisabled}
              onClick={sendDraft}
            >
              <ArrowUpIcon size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
