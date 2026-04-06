import { useEffect, useState } from "react";

import type { ConversationImageAttachment } from "../../lib/types";
import { CloseIcon } from "../../shared/Icons";
import { useConversationImagePreviews } from "./useConversationImagePreviews";

type Props = {
  images: ConversationImageAttachment[] | null | undefined;
};

export function ConversationMessageImages({ images }: Props) {
  const previews = useConversationImagePreviews(images);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const activePreview =
    activeIndex === null ? null : previews[activeIndex] ?? null;

  useEffect(() => {
    if (!activePreview) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setActiveIndex(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activePreview]);

  if (previews.length === 0) {
    return null;
  }

  return (
    <>
      <div
        className={`tx-message-images ${
          previews.length === 1 ? "tx-message-images--single" : ""
        }`}
      >
        {previews.map((image, index) => {
          const canOpen = Boolean(image.previewUrl);
          return (
            <button
              key={image.key}
              type="button"
              className="tx-message-images__button"
              aria-label={canOpen ? `Open ${image.label}` : image.label}
              disabled={!canOpen}
              onClick={() => setActiveIndex(index)}
            >
              <div className="tx-message-images__frame">
                {image.previewUrl ? (
                  <img
                    className="tx-message-images__image"
                    src={image.previewUrl}
                    alt={image.label}
                  />
                ) : (
                  <span className="tx-message-images__placeholder">
                    {image.loading ? "Loading…" : image.label}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {activePreview?.previewUrl ? (
        <div
          className="tx-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={activePreview.label}
          onClick={() => setActiveIndex(null)}
        >
          <div
            className="tx-image-lightbox__dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="tx-image-lightbox__close"
              aria-label="Close image preview"
              onClick={() => setActiveIndex(null)}
            >
              <CloseIcon size={14} />
            </button>
            <img
              className="tx-image-lightbox__image"
              src={activePreview.previewUrl}
              alt={activePreview.label}
            />
            <div className="tx-image-lightbox__label">{activePreview.label}</div>
          </div>
        </div>
      ) : null}
    </>
  );
}
