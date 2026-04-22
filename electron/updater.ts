import { app } from "electron";
import * as electronUpdater from "electron-updater";
import type {
  AppUpdater as ElectronUpdater,
  CancellationToken as ElectronCancellationToken,
  ProgressInfo,
  UpdateInfo,
} from "electron-updater";
import type { ReleaseNoteInfo } from "builder-util-runtime";

import type {
  DesktopUpdate,
  DesktopUpdateDownloadEvent,
} from "../src/lib/desktop-types.js";

type UpdateDownloadHandler = (event: DesktopUpdateDownloadEvent) => void;

type PendingUpdateOffer = {
  readonly id: string;
  readonly info: UpdateInfo;
  readonly cancellationToken: ElectronCancellationToken;
  closed: boolean;
  downloading: boolean;
};

const { autoUpdater, CancellationToken } = electronUpdater;
const DEV_UPDATER_ENV = "SKEIN_ENABLE_DEV_UPDATER";

function shouldEnableUpdater(appUpdater: ElectronUpdater) {
  if (app.isPackaged) {
    return true;
  }

  if (process.env[DEV_UPDATER_ENV] === "1") {
    appUpdater.forceDevUpdateConfig = true;
    return true;
  }

  return false;
}

function sameVersion(a: string, b: string) {
  const left = a.startsWith("v") ? a.slice(1) : a;
  const right = b.startsWith("v") ? b.slice(1) : b;
  return left === right;
}

export class AppUpdater {
  private readonly updater: ElectronUpdater;
  private activeOffer: PendingUpdateOffer | null = null;
  private downloadedVersion: string | null = null;
  private inFlightTransfer: Promise<void> | null = null;
  private readonly enabled: boolean;
  private nextOfferId = 0;
  private actionQueue: Promise<void> = Promise.resolve();

  constructor(updater: ElectronUpdater = autoUpdater) {
    this.updater = updater;
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.allowPrerelease = app.getVersion().includes("-");
    this.enabled = shouldEnableUpdater(this.updater);
  }

  async check(): Promise<DesktopUpdate | null> {
    return this.runExclusive(async () => {
      if (!this.enabled) {
        return null;
      }

      const activeOffer = this.activeOffer;
      if (activeOffer && !activeOffer.closed) {
        return this.toDesktopUpdate(activeOffer);
      }

      await this.waitForSettledTransfer();

      const result = await this.updater.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        this.releaseOffer(this.activeOffer);
        return null;
      }

      if (sameVersion(result.updateInfo.version, app.getVersion())) {
        this.releaseOffer(this.activeOffer);
        return null;
      }

      const offer: PendingUpdateOffer = {
        id: this.createOfferId(),
        info: result.updateInfo,
        cancellationToken: result.cancellationToken ?? new CancellationToken(),
        closed: false,
        downloading: false,
      };
      this.releaseOffer(this.activeOffer);
      this.activeOffer = offer;

      return this.toDesktopUpdate(offer);
    });
  }

  async close(updateId: string) {
    await this.runExclusive(async () => {
      const offer = this.requireActiveOffer(updateId);
      this.releaseOffer(offer);
    });
  }

  async downloadAndInstall(updateId: string, onEvent?: UpdateDownloadHandler) {
    const offer = await this.runExclusive(async () => {
      const offer = this.requireActiveOffer(updateId);
      if (offer.downloading) {
        throw new Error("This update is already downloading.");
      }

      offer.downloading = true;
      return offer;
    });

    const transfer = this.downloadUpdate(offer, onEvent);
    this.inFlightTransfer = transfer;
    try {
      await transfer;
    } finally {
      await this.runExclusive(async () => {
        if (this.activeOffer === offer && !offer.closed) {
          this.releaseOffer(offer);
        }
        offer.downloading = false;
        if (this.inFlightTransfer === transfer) {
          this.inFlightTransfer = null;
        }
      });
    }
  }

  restartToApplyUpdate() {
    if (!this.downloadedVersion) {
      return false;
    }

    this.updater.quitAndInstall();
    return true;
  }

  private requireActiveOffer(updateId: string) {
    const offer = this.activeOffer;
    if (!offer || offer.id !== updateId || offer.closed) {
      throw new Error("This update is no longer active.");
    }

    return offer;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.actionQueue.then(operation, operation);
    this.actionQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private toDesktopUpdate(offer: PendingUpdateOffer): DesktopUpdate {
    return {
      id: offer.id,
      currentVersion: app.getVersion(),
      version: offer.info.version,
      date: offer.info.releaseDate ?? null,
      body: normalizeReleaseNotes(offer.info.releaseNotes),
    };
  }

  private async waitForSettledTransfer() {
    const transfer = this.inFlightTransfer;
    if (!transfer) {
      return;
    }

    await transfer.catch(() => undefined);
  }

  private releaseOffer(offer: PendingUpdateOffer | null) {
    if (!offer || offer.closed) {
      return;
    }

    offer.closed = true;
    if (this.activeOffer === offer) {
      this.activeOffer = null;
    }
    offer.cancellationToken.cancel();
  }

  private createOfferId() {
    this.nextOfferId += 1;
    return `offer-${this.nextOfferId}`;
  }

  private async downloadUpdate(
    offer: PendingUpdateOffer,
    onEvent?: UpdateDownloadHandler,
  ) {
    let previousTransferred = 0;
    let started = false;

    const emitStarted = (contentLength?: number | null) => {
      if (started) {
        return;
      }

      started = true;
      this.safeEmit(onEvent, {
        event: "Started",
        data: {
          contentLength: contentLength ?? null,
        },
      });
    };

    const handleProgress = (progress: ProgressInfo) => {
      emitStarted(progress.total);
      const transferred = Math.max(previousTransferred, progress.transferred);
      const chunkLength = transferred - previousTransferred;
      previousTransferred = transferred;
      if (chunkLength <= 0) {
        return;
      }

      this.safeEmit(onEvent, {
        event: "Progress",
        data: {
          chunkLength,
        },
      });
    };

    this.updater.on("download-progress", handleProgress);
    try {
      await this.updater.downloadUpdate(offer.cancellationToken);
      emitStarted(null);
      this.downloadedVersion = offer.info.version;
      this.safeEmit(onEvent, {
        event: "Finished",
      });
    } finally {
      this.updater.off("download-progress", handleProgress);
    }
  }

  private safeEmit(
    onEvent: UpdateDownloadHandler | undefined,
    event: DesktopUpdateDownloadEvent,
  ) {
    try {
      onEvent?.(event);
    } catch {
      // Ignore renderer delivery failures so they cannot break updater state.
    }
  }
}

function normalizeReleaseNotes(releaseNotes: UpdateInfo["releaseNotes"]) {
  if (typeof releaseNotes === "string") {
    return releaseNotes;
  }

  if (!Array.isArray(releaseNotes)) {
    return null;
  }

  const notes = (releaseNotes as ReleaseNoteInfo[])
    .map((entry) => {
      if (typeof entry.note === "string") {
        const version = entry.version ? `${entry.version}\n` : "";
        return `${version}${entry.note}`.trim();
      }

      return "";
    })
    .filter(Boolean);

  return notes.length > 0 ? notes.join("\n\n") : null;
}
