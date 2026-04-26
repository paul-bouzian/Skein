import type { ReactNode } from "react";

import { DownloadIcon } from "../../shared/Icons";
import type { AppUpdateState } from "../../lib/types";
import { useAppUpdateStore } from "../../stores/app-update-store";
import "./SidebarUpdateButton.css";

type Variant = "available" | "downloading" | "ready" | "error";

type Action = {
  label: ReactNode;
  showIcon: boolean;
  variant: Variant;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
};

export function SidebarUpdateButton() {
  const state = useAppUpdateStore((store) => store.state);
  const snapshot = useAppUpdateStore((store) => store.snapshot);
  const error = useAppUpdateStore((store) => store.error);
  const downloadedBytes = useAppUpdateStore((store) => store.downloadedBytes);
  const contentLength = useAppUpdateStore((store) => store.contentLength);
  const noticeVisible = useAppUpdateStore((store) => store.noticeVisible);
  const startDownload = useAppUpdateStore((store) => store.startDownload);
  const installAndRestart = useAppUpdateStore(
    (store) => store.installAndRestart,
  );
  const checkNow = useAppUpdateStore((store) => store.checkNow);

  if (!shouldRender(state, error, noticeVisible)) {
    return null;
  }

  const version = snapshot?.availableVersion ?? null;
  const progressPercent = computeProgressPercent(downloadedBytes, contentLength);
  const action = buildAction({
    state,
    version,
    progressPercent,
    error,
    startDownload,
    installAndRestart,
    checkNow,
  });

  return (
    <button
      type="button"
      className={`sidebar-update sidebar-update--${action.variant}`}
      onClick={action.onClick}
      disabled={action.disabled}
      title={action.title}
      aria-label={action.ariaLabel}
    >
      {state === "downloading" ? (
        <span
          className="sidebar-update__progress-fill"
          style={{ width: `${progressPercent ?? 5}%` }}
          aria-hidden="true"
        />
      ) : null}
      <span className="sidebar-update__sizer" aria-hidden="true">
        <DownloadIcon size={12} className="sidebar-update__icon" />
        <span>{ghostLabel(version)}</span>
      </span>
      <span className="sidebar-update__visible">
        {action.showIcon ? (
          <DownloadIcon size={12} className="sidebar-update__icon" />
        ) : null}
        <span>{action.label}</span>
      </span>
    </button>
  );
}

function shouldRender(
  state: AppUpdateState,
  error: string | null,
  noticeVisible: boolean,
): boolean {
  switch (state) {
    case "downloading":
    case "downloaded":
    case "installing":
      return true;
    case "available":
      return noticeVisible;
    case "error":
      return Boolean(error) && noticeVisible;
    default:
      return false;
  }
}

function computeProgressPercent(
  downloadedBytes: number,
  contentLength: number | null,
): number | null {
  if (!contentLength || contentLength <= 0) return null;
  return Math.min(100, Math.round((downloadedBytes / contentLength) * 100));
}

function ghostLabel(version: string | null): string {
  return version ? `Install ${version}` : "Install update";
}

function buildAction(args: {
  state: AppUpdateState;
  version: string | null;
  progressPercent: number | null;
  error: string | null;
  startDownload: () => Promise<void>;
  installAndRestart: () => Promise<void>;
  checkNow: () => Promise<void>;
}): Action {
  const { state, version, progressPercent, error } = args;

  switch (state) {
    case "downloading":
      return {
        label:
          progressPercent !== null ? `Update ${progressPercent}%` : "Update…",
        showIcon: false,
        variant: "downloading",
        disabled: true,
        ariaLabel: `Downloading update ${progressPercent ?? 0}%`,
      };
    case "downloaded":
      return {
        label: `Install${version ? ` ${version}` : ""}`,
        showIcon: false,
        variant: "ready",
        onClick: () => void args.installAndRestart(),
        title: version ? `Install ${version} and restart` : undefined,
      };
    case "installing":
      return {
        label: "Restarting…",
        showIcon: false,
        variant: "ready",
        disabled: true,
      };
    case "error":
      return {
        label: "Retry",
        showIcon: false,
        variant: "error",
        onClick: () => void args.checkNow(),
        title: error ?? undefined,
      };
    default:
      return {
        label: version ?? "Update",
        showIcon: true,
        variant: "available",
        onClick: () => void args.startDownload(),
        title: version ? `Update available: ${version}` : "Update available",
        ariaLabel: version
          ? `Update available: ${version}`
          : "Update available",
      };
  }
}
