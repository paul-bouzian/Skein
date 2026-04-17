import { useRef, type KeyboardEvent } from "react";

import { CloseIcon, PlusIcon } from "../../shared/Icons";
import { MAX_BROWSER_TABS, type BrowserTab } from "../../stores/browser-store";

type Props = {
  tabs: BrowserTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
};

export function BrowserTabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNewTab,
}: Props) {
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const atCap = tabs.length >= MAX_BROWSER_TABS;

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    onActivate(nextTab.id);
    buttonRefs.current[nextTab.id]?.focus();
  }

  return (
    <div
      className="browser-panel__tabs"
      role="tablist"
      aria-label="Browser tabs"
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`browser-tab ${isActive ? "browser-tab--active" : ""}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className="browser-tab__title"
              title={tab.history[tab.cursor] ?? tab.title}
              ref={(element) => {
                buttonRefs.current[tab.id] = element;
              }}
              onClick={() => onActivate(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {tab.title || "New tab"}
            </button>
            <button
              type="button"
              className="browser-tab__close"
              aria-label="Close tab"
              onClick={() => onClose(tab.id)}
            >
              <CloseIcon size={11} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="browser-panel__action browser-panel__new-tab"
        aria-label={atCap ? `Maximum ${MAX_BROWSER_TABS} tabs` : "New tab"}
        title={atCap ? `Maximum ${MAX_BROWSER_TABS} tabs` : "New tab"}
        disabled={atCap}
        onClick={onNewTab}
      >
        <PlusIcon size={12} />
      </button>
    </div>
  );
}
