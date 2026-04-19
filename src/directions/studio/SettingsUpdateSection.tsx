import { APP_NAME } from "../../lib/app-identity";
import { useAppUpdateStore } from "../../stores/app-update-store";

type Props = {
  disabled?: boolean;
};

export function SettingsUpdateSection({ disabled = false }: Props) {
  const state = useAppUpdateStore((store) => store.state);
  const snapshot = useAppUpdateStore((store) => store.snapshot);
  const error = useAppUpdateStore((store) => store.error);
  const downloadedBytes = useAppUpdateStore((store) => store.downloadedBytes);
  const contentLength = useAppUpdateStore((store) => store.contentLength);
  const checkNow = useAppUpdateStore((store) => store.checkNow);
  const viewChanges = useAppUpdateStore((store) => store.viewChanges);
  const install = useAppUpdateStore((store) => store.install);

  const isBusy = disabled || state === "checking" || state === "installing";
  const showInstallAction = state === "available" && snapshot;
  const progressLabel =
    contentLength && contentLength > 0
      ? `${Math.min(
          100,
          Math.round((downloadedBytes / contentLength) * 100),
        )}% downloaded`
      : downloadedBytes > 0
        ? `${formatBytes(downloadedBytes)} downloaded`
        : null;

  return (
    <div className="settings-update-card" aria-label="App updates">
      <div className="settings-update-card__status">
        {state === "checking" ? (
          <p className="settings-field__help">Checking for updates…</p>
        ) : null}
        {state === "latest" ? (
          <p className="settings-field__help">
            {APP_NAME} is up to date.
          </p>
        ) : null}
        {snapshot ? (
          <p className="settings-field__help">
            Latest release <code>{snapshot.availableVersion}</code>
          </p>
        ) : null}
        {progressLabel ? (
          <p className="settings-field__help">{progressLabel}</p>
        ) : null}
        {error ? <p className="settings-update-card__error">{error}</p> : null}
      </div>

      <div className="settings-update-card__actions">
        <button
          type="button"
          className="tx-action-btn tx-action-btn--secondary"
          disabled={isBusy}
          onClick={() => void checkNow()}
        >
          {state === "checking" ? "Checking..." : "Check for updates"}
        </button>
        {showInstallAction ? (
          <>
            <button
              type="button"
              className="tx-action-btn tx-action-btn--secondary"
              disabled={isBusy}
              onClick={() => void viewChanges()}
            >
              View changes
            </button>
            <button
              type="button"
              className="tx-action-btn tx-action-btn--primary"
              disabled={isBusy}
              onClick={() => void install()}
            >
              Install and restart
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}
