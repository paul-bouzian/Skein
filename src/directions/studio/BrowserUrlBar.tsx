import { useEffect, useId, useState, type FormEvent } from "react";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  OpenInIcon,
  ReloadIcon,
} from "../../shared/Icons";
import { Tooltip } from "../../shared/Tooltip";
import type { DetectedUrl } from "../../stores/browser-store";

type Props = {
  currentUrl: string;
  canGoBack: boolean;
  canGoForward: boolean;
  detectedUrls: DetectedUrl[];
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onNavigate: (url: string) => void;
  onOpenExternal?: (url: string) => void;
};

export function normalizeBrowserUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (
    /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(trimmed)
  ) {
    return `http://${trimmed}`;
  }
  if (!trimmed.includes(".") && !trimmed.includes(":")) return null;
  return `https://${trimmed}`;
}

export function BrowserUrlBar({
  currentUrl,
  canGoBack,
  canGoForward,
  detectedUrls,
  onBack,
  onForward,
  onReload,
  onNavigate,
  onOpenExternal,
}: Props) {
  const datalistId = useId();
  const [draft, setDraft] = useState(currentUrl);

  useEffect(() => {
    setDraft(currentUrl);
  }, [currentUrl]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeBrowserUrl(draft);
    if (!normalized) return;
    onNavigate(normalized);
  }

  const showExternal = Boolean(onOpenExternal && currentUrl);

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
      <Tooltip content="Reload" side="bottom">
        <button
          type="button"
          className="browser-panel__action"
          aria-label="Reload"
          onClick={onReload}
        >
          <ReloadIcon size={13} />
        </button>
      </Tooltip>
      <input
        type="text"
        className="browser-url-bar__input"
        aria-label="Address"
        placeholder="http://localhost:5173"
        value={draft}
        list={datalistId}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setDraft(event.target.value)}
      />
      <datalist id={datalistId}>
        {detectedUrls.map((entry) => (
          <option key={entry.url} value={entry.url} />
        ))}
      </datalist>
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
