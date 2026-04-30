import type { ProviderKind, ThreadComposerCatalog } from "../../../lib/types";
import { ComposerTokenText } from "../ComposerTokenText";

type Props = {
  draft: string;
  catalog: ThreadComposerCatalog | null;
  cursorIndex: number | null;
  placeholder: string;
  provider: ProviderKind;
  showCaret: boolean;
  scrollTop: number;
};

export function ComposerTextMirror({
  draft,
  catalog,
  cursorIndex,
  placeholder,
  provider,
  showCaret,
  scrollTop,
}: Props) {
  return (
    <div className="tx-inline-composer__mirror" aria-hidden="true">
      <div
        className="tx-inline-composer__mirror-content"
        style={
          draft.length === 0
            ? undefined
            : { transform: `translateY(-${scrollTop}px)` }
        }
      >
        {draft.length === 0 ? (
          <span className="tx-inline-composer__placeholder">{placeholder}</span>
        ) : (
          <ComposerTokenText
            text={draft}
            catalog={catalog}
            cursorIndex={cursorIndex}
            provider={provider}
            keyPrefix="composer-mirror"
            showCaret={showCaret}
          />
        )}
        <span> </span>
      </div>
    </div>
  );
}
