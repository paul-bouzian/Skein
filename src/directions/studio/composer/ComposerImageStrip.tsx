import type { ConversationImageAttachment } from "../../../lib/types";
import { CloseIcon } from "../../../shared/Icons";
import { useConversationImagePreviews } from "../useConversationImagePreviews";

type Props = {
  disabled: boolean;
  images: ConversationImageAttachment[];
  onRemove: (key: string) => void;
};

export function ComposerImageStrip({ disabled, images, onRemove }: Props) {
  const previews = useConversationImagePreviews(images);

  if (previews.length === 0) {
    return null;
  }

  return (
    <div className="tx-composer-images" aria-label="Attached images">
      {previews.map((image) => (
        <div key={image.key} className="tx-composer-images__item">
          <div className="tx-composer-images__thumb">
            {image.previewUrl ? (
              <img src={image.previewUrl} alt="" />
            ) : (
              <span className="tx-composer-images__placeholder">
                {image.loading ? "…" : "?"}
              </span>
            )}
          </div>
          <span className="tx-composer-images__label" title={image.label}>
            {image.label}
          </span>
          <button
            type="button"
            className="tx-composer-images__remove"
            aria-label={`Remove ${image.label}`}
            disabled={disabled}
            onClick={() => onRemove(image.key)}
          >
            <CloseIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
