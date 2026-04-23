import { useId, useState, type FormEvent } from "react";

import { normalizeBrowserUrl } from "../../lib/browser-preview";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BugIcon,
  OpenInIcon,
  ReloadIcon,
} from "../../shared/Icons";
import { Tooltip } from "../../shared/Tooltip";
import type { DetectedUrl } from "../../stores/browser-store";

type Props = {
  currentUrl: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  detectedUrls: DetectedUrl[];
  canOpenDevTools?: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onNavigate: (url: string) => void;
  onOpenExternal?: (url: string) => void;
  onOpenDevTools?: () => void;
};

export function BrowserUrlBar({
  currentUrl,
  canGoBack,
  canGoForward,
  loading,
  detectedUrls,
  canOpenDevTools = false,
  onBack,
  onForward,
  onReload,
  onNavigate,
  onOpenExternal,
  onOpenDevTools,
}: Props) {
  const datalistId = useId();
  const [draftState, setDraftState] = useState<{
    sourceUrl: string;
    value: string;
  }>(() => ({ sourceUrl: currentUrl, value: currentUrl }));

  // Derive the displayed value without a mirroring useEffect: if the
  // parent pushed a new URL since the user last typed, show that URL;
  // otherwise show the in-progress draft.
  const draft =
    draftState.sourceUrl === currentUrl ? draftState.value : currentUrl;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = normalizeBrowserUrl(draft);
    if (!normalized) return;
    onNavigate(normalized);
  }

  const showExternal = Boolean(onOpenExternal && currentUrl);
  const showDevTools = Boolean(onOpenDevTools);

  return (
    <form className="browser-url-bar" onSubmit={handleSubmit}>
      <Tooltip content="Back" side="bottom">
        <button
          type="button"
          className="browser-panel__action"
          aria-label="Back"
          disabled={!canGoBack}
          onClick={onBack}
        >
          <ArrowLeftIcon size={13} />
        </button>
      </Tooltip>
      <Tooltip content="Forward" side="bottom">
        <button
          type="button"
          className="browser-panel__action"
          aria-label="Forward"
          disabled={!canGoForward}
          onClick={onForward}
        >
          <ArrowRightIcon size={13} />
        </button>
      </Tooltip>
      <Tooltip content={loading ? "Loading…" : "Reload"} side="bottom">
        <button
          type="button"
          className={`browser-panel__action browser-url-bar__reload${loading ? " browser-url-bar__reload--loading" : ""}`}
          aria-label={loading ? "Loading" : "Reload"}
          aria-busy={loading || undefined}
          onClick={onReload}
        >
          <ReloadIcon size={13} />
        </button>
      </Tooltip>
      <input
        type="text"
        className={`browser-url-bar__input${loading ? " browser-url-bar__input--loading" : ""}`}
        aria-label="Address"
        placeholder="http://localhost:5173"
        value={draft}
        list={datalistId}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) =>
          setDraftState({ sourceUrl: currentUrl, value: event.target.value })
        }
      />
      <datalist id={datalistId}>
        {detectedUrls.map((entry) => (
          <option key={entry.url} value={entry.url} />
        ))}
      </datalist>
      {showDevTools && (
        <Tooltip content="Open DevTools" side="bottom">
          <button
            type="button"
            className="browser-panel__action"
            aria-label="Open DevTools"
            disabled={!canOpenDevTools}
            onClick={onOpenDevTools}
          >
            <BugIcon size={13} />
          </button>
        </Tooltip>
      )}
      {showExternal && (
        <Tooltip content="Open in external browser" side="bottom">
          <button
            type="button"
            className="browser-panel__action"
            aria-label="Open in external browser"
            onClick={() => onOpenExternal?.(currentUrl)}
          >
            <OpenInIcon size={13} />
          </button>
        </Tooltip>
      )}
    </form>
  );
}
