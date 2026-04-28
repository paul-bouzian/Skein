import type { ProviderKind, ThreadComposerCatalog } from "../../../lib/types";
import {
  decorateComposerText,
  type ComposerMirrorPart,
} from "./composer-model";

type Props = {
  draft: string;
  catalog: ThreadComposerCatalog | null;
  placeholder: string;
  provider: ProviderKind;
  scrollTop: number;
};

export function ComposerTextMirror({
  draft,
  catalog,
  placeholder,
  provider,
  scrollTop,
}: Props) {
  const segments = decorateComposerText(draft, catalog, provider);

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
          segments.map((segment, index) => {
            if (segment.kind === "text") {
              return <span key={`text-${index}`}>{segment.text}</span>;
            }
            if (segment.kind === "prompt") {
              return (
                <span
                  key={`prompt-${index}`}
                  className="tx-inline-token tx-inline-token--prompt"
                >
                  {segment.parts.map((part, partIndex) => (
                    <MirrorPart key={`prompt-part-${partIndex}`} part={part} />
                  ))}
                </span>
              );
            }
            return (
              <span
                key={`${segment.kind}-${index}`}
                className={`tx-inline-token tx-inline-token--${segment.kind}`}
              >
                {segment.text}
              </span>
            );
          })
        )}
        <span> </span>
      </div>
    </div>
  );
}

function MirrorPart({ part }: { part: ComposerMirrorPart }) {
  return (
    <span
      className={
        part.tone === "base"
          ? undefined
          : `tx-inline-token__part tx-inline-token__part--${part.tone}`
      }
    >
      {part.text}
    </span>
  );
}
