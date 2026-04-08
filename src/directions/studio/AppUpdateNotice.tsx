import type { AppUpdateSnapshot } from "../../lib/types";
import { useAppUpdateStore } from "../../stores/app-update-store";
import { CloseIcon, DownloadIcon } from "../../shared/Icons";
import "./AppUpdateNotice.css";

export function AppUpdateNotice() {
  const state = useAppUpdateStore((store) => store.state);
  const snapshot = useAppUpdateStore((store) => store.snapshot);
  const error = useAppUpdateStore((store) => store.error);
  const downloadedBytes = useAppUpdateStore((store) => store.downloadedBytes);
  const contentLength = useAppUpdateStore((store) => store.contentLength);
  const dismiss = useAppUpdateStore((store) => store.dismiss);
  const viewChanges = useAppUpdateStore((store) => store.viewChanges);
  const install = useAppUpdateStore((store) => store.install);

  if (!snapshot || (state !== "available" && state !== "installing")) {
    return null;
  }

  const progressRatio =
    contentLength && contentLength > 0
      ? Math.min(downloadedBytes / contentLength, 1)
      : null;

  return (
    <aside className="tx-update-notice" aria-live="polite">
      <div className="tx-update-notice__header">
        <div>
          <p className="tx-update-notice__eyebrow">Update available</p>
          <h3 className="tx-update-notice__title">
            Loom {snapshot.availableVersion}
          </h3>
          <p className="tx-update-notice__meta">
            Installed {snapshot.currentVersion}
            {snapshot.releaseDate ? ` • ${formatReleaseDate(snapshot)}` : ""}
          </p>
        </div>
        <button
          type="button"
          className="tx-update-notice__dismiss"
          onClick={dismiss}
          title="Dismiss update notice"
        >
          <CloseIcon size={12} />
        </button>
      </div>

      {snapshot.notes ? (
        <p className="tx-update-notice__notes">{summarizeNotes(snapshot)}</p>
      ) : null}

      {error ? <p className="tx-update-notice__error">{error}</p> : null}

      {state === "installing" ? (
        <div className="tx-update-notice__progress">
          <div className="tx-update-notice__progress-header">
            <span>Downloading and installing…</span>
            {progressRatio !== null ? (
              <span>{Math.round(progressRatio * 100)}%</span>
            ) : null}
          </div>
          <div className="tx-update-notice__progress-track">
            <div
              className="tx-update-notice__progress-bar"
              style={{ width: `${Math.round((progressRatio ?? 0.1) * 100)}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="tx-update-notice__actions">
          <button
            type="button"
            className="tx-update-notice__secondary"
            onClick={() => void viewChanges()}
          >
            View changes
          </button>
          <button
            type="button"
            className="tx-update-notice__primary"
            onClick={() => void install()}
          >
            <DownloadIcon size={14} />
            <span>Install update</span>
          </button>
        </div>
      )}
    </aside>
  );
}

function summarizeNotes(snapshot: AppUpdateSnapshot) {
  const notes = snapshot.notes?.trim() ?? "";
  if (!notes) return "";
  const compact = notes.replace(/\s+/g, " ");
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}…`;
}

function formatReleaseDate(snapshot: AppUpdateSnapshot) {
  if (!snapshot.releaseDate) return "";
  const releaseDate = new Date(snapshot.releaseDate);
  if (Number.isNaN(releaseDate.getTime())) return snapshot.releaseDate;
  return releaseDate.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
