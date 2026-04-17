import { useEffect, useRef } from "react";

type Props = {
  tabId: string;
  url: string;
  reloadNonce: number;
  active: boolean;
  onLoad: (tabId: string) => void;
  onLoadError?: (tabId: string) => void;
};

const BLANK_URL = "about:blank";

export function BrowserFrame({
  tabId,
  url,
  reloadNonce,
  active,
  onLoad,
  onLoadError,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const handleLoad = () => onLoad(tabId);
    iframe.addEventListener("load", handleLoad);
    return () => {
      iframe.removeEventListener("load", handleLoad);
    };
  }, [tabId, onLoad, reloadNonce, url]);

  return (
    <iframe
      ref={iframeRef}
      key={`${tabId}:${reloadNonce}:${url}`}
      className={`browser-frame ${active ? "" : "browser-frame--hidden"}`}
      data-testid="browser-frame"
      data-tab-id={tabId}
      src={url || BLANK_URL}
      title={`Browser tab ${tabId}`}
      onError={() => onLoadError?.(tabId)}
      sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts allow-downloads"
      allow="clipboard-read; clipboard-write; fullscreen"
    />
  );
}
