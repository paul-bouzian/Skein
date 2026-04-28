import { Fragment, useEffect } from "react";
import type { ReactNode } from "react";

import { APP_NAME } from "../../lib/app-identity";
import { openExternalUrl } from "../../lib/shell";
import { CloseIcon } from "../../shared/Icons";
import { useAppUpdateStore } from "../../stores/app-update-store";
import {
  parseReleaseNotes,
  type ReleaseNotesBlock,
} from "./release-notes-parser";
import "./ReleaseNotesCard.css";

export function ReleaseNotesCard() {
  const pending = useAppUpdateStore((store) => store.pendingReleaseNotes);
  const dismiss = useAppUpdateStore((store) => store.dismissReleaseNotes);

  useEffect(() => {
    if (!pending) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        dismiss();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, dismiss]);

  if (!pending) return null;

  const blocks = parseReleaseNotes(pending.notes);
  const formattedDate = formatReleaseDate(pending.releaseDate);

  return (
    <div className="release-notes-overlay" role="dialog" aria-modal="true">
      <div
        className="release-notes-overlay__backdrop"
        onClick={dismiss}
        aria-hidden="true"
      />
      <article className="release-notes-card">
        <div className="release-notes-card__mesh" aria-hidden="true">
          <span className="release-notes-card__blob release-notes-card__blob--accent" />
          <span className="release-notes-card__blob release-notes-card__blob--info" />
          <span className="release-notes-card__blob release-notes-card__blob--warm" />
        </div>
        <button
          type="button"
          className="release-notes-card__close"
          onClick={dismiss}
          aria-label="Dismiss release notes"
        >
          <CloseIcon size={14} />
        </button>
        <div className="release-notes-card__body">
          <p className="release-notes-card__eyebrow">{`What's new in ${APP_NAME}`}</p>
          <h1 className="release-notes-card__version">{pending.version}</h1>
          {formattedDate ? (
            <p className="release-notes-card__date">{formattedDate}</p>
          ) : null}
          <div className="release-notes-card__content">
            {blocks.length > 0 ? (
              blocks.map(renderBlock)
            ) : (
              <p className="release-notes-card__paragraph">
                Thanks for updating. Check the full release notes on GitHub for
                everything that changed.
              </p>
            )}
          </div>
          <div className="release-notes-card__actions">
            <button
              type="button"
              className="release-notes-card__btn release-notes-card__btn--secondary"
              onClick={dismiss}
            >
              Continue
            </button>
            <button
              type="button"
              className="release-notes-card__btn release-notes-card__btn--primary"
              onClick={() => void openExternalUrl(pending.releaseUrl)}
            >
              View on GitHub
            </button>
          </div>
        </div>
      </article>
    </div>
  );
}

function renderBlock(block: ReleaseNotesBlock, index: number): ReactNode {
  switch (block.kind) {
    case "heading":
      return (
        <h2 key={index} className="release-notes-card__heading">
          {renderInline(block.text)}
        </h2>
      );
    case "list":
      return (
        <ul key={index} className="release-notes-card__list">
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "paragraph":
      return (
        <p key={index} className="release-notes-card__paragraph">
          {renderInline(block.text)}
        </p>
      );
  }
}

function renderInline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((segment, index) => {
    const match = segment.match(/^\*\*([^*]+)\*\*$/);
    if (match) {
      return <strong key={index}>{match[1]}</strong>;
    }
    return <Fragment key={index}>{segment}</Fragment>;
  });
}

function formatReleaseDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
