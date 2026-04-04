import type { ComposerAutocompleteItem } from "./composer-model";

type Props = {
  items: ComposerAutocompleteItem[];
  activeIndex: number;
  onSelect: (item: ComposerAutocompleteItem) => void;
};

export function ComposerAutocompleteMenu({
  items,
  activeIndex,
  onSelect,
}: Props) {
  if (items.length === 0) {
    return null;
  }

  let lastGroup = "";

  return (
    <div className="tx-composer-menu" role="listbox" aria-label="Composer suggestions">
      {items.map((item, index) => {
        const showGroup = item.group !== lastGroup;
        lastGroup = item.group;

        return (
          <div key={item.id}>
            {showGroup ? <div className="tx-composer-menu__group">{item.group}</div> : null}
            <button
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`tx-composer-menu__item ${index === activeIndex ? "tx-composer-menu__item--active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(item);
              }}
            >
              <span className="tx-composer-menu__label-row">
                <span className="tx-composer-menu__label">{item.label}</span>
                {item.hint ? <span className="tx-composer-menu__hint">{item.hint}</span> : null}
              </span>
              {item.description ? (
                <span className="tx-composer-menu__description">{item.description}</span>
              ) : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}
