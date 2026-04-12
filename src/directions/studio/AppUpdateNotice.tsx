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
  const noticeVisible = useAppUpdateStore((store) => store.noticeVisible);
  const checkNow = useAppUpdateStore((store) => store.checkNow);
  const dismiss = useAppUpdateStore((store) => store.dismiss);
  const viewChanges = useAppUpdateStore((store) => store.viewChanges);
  const install = useAppUpdateStore((store) => store.install);

  if (!noticeVisible && state !== "installing") {
    return null;
  }

  if (!snapshot && state !== "checking" && state !== "latest" && state !== "error") {
    return null;
  }

  const progressRatio =
    contentLength && contentLength > 0
      ? Math.min(downloadedBytes / contentLength, 1)
      : null;
  const title =
    state === "checking"
      ? "Checking for updates"
      : state === "latest"
        ? "Loom is up to date"
        : state === "error"
          ? "Update check failed"
          : `Loom ${snapshot?.availableVersion ?? ""}`.trim();
  const meta = snapshot
    ? `Installed ${snapshot.currentVersion}${snapshot.releaseDate ? ` • ${formatReleaseDate(snapshot)}` : ""}`
    : null;

  return (
    <aside className="tx-update-notice" aria-live="polite">
      <div className="tx-update-notice__header">
        <div>
          <p className="tx-update-notice__eyebrow">
            {state === "available" || state === "installing"
              ? "Update available"
              : "Application update"}
          </p>
          <h3 className="tx-update-notice__title">{title}</h3>
          {meta ? <p className="tx-update-notice__meta">{meta}</p> : null}
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

      {snapshot?.notes ? (
        <p className="tx-update-notice__notes">{summarizeNotes(snapshot)}</p>
      ) : null}

      {error ? <p className="tx-update-notice__error">{error}</p> : null}

      {state === "checking" ? (
        <p className="tx-update-notice__meta">Checking for updates…</p>
      ) : null}

      {state === "latest" ? (
        <p className="tx-update-notice__meta">Loom is already up to date.</p>
      ) : null}

      {state === "error" ? (
        <div className="tx-update-notice__actions">
          <button
            type="button"
            className="tx-action-btn tx-action-btn--secondary"
            onClick={dismiss}
          >
            Dismiss
          </button>
          <button
            type="button"
            className="tx-action-btn tx-action-btn--primary"
            onClick={() => void checkNow()}
          >
            Try again
          </button>
        </div>
      ) : null}

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
      ) : state === "available" ? (
        <div className="tx-update-notice__actions">
          <button
            type="button"
            className="tx-action-btn tx-action-btn--secondary"
            onClick={() => void viewChanges()}
          >
            View changes
          </button>
          <button
            type="button"
            className="tx-action-btn tx-action-btn--primary"
            onClick={() => void install()}
          >
            <DownloadIcon size={14} />
            <span>Install update</span>
          </button>
        </div>
      ) : null}

      {state === "latest" ? (
        <div className="tx-update-notice__actions">
          <button
            type="button"
            className="tx-action-btn tx-action-btn--secondary"
            onClick={dismiss}
          >
            Dismiss
          </button>
        </div>
      ) : null}
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
