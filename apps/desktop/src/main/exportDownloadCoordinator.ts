import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  DownloadItem,
  Event as ElectronEvent,
  Session,
  WebContents,
} from "electron";
import {
  EXPORT_DOWNLOAD_REQUEST_FRAGMENT_KEY,
  EXPORT_DOWNLOAD_RESULT_CHANNEL,
  type ExportDownloadFailureReason,
  type ExportDownloadFormat,
  type ExportDownloadRegistration,
  type ExportDownloadRegistrationInput,
  type ExportDownloadResult,
} from "../exportDownloadContract.js";

export {
  EXPORT_DOWNLOAD_CANCEL_CHANNEL,
  EXPORT_DOWNLOAD_REGISTER_CHANNEL,
  EXPORT_DOWNLOAD_RESULT_CHANNEL,
  EXPORT_DOWNLOAD_REVEAL_CHANNEL,
} from "../exportDownloadContract.js";
export type {
  ExportDownloadFailureReason,
  ExportDownloadFormat,
  ExportDownloadRegistration,
  ExportDownloadRegistrationInput,
  ExportDownloadResult,
  ExportDownloadSaveResult,
} from "../exportDownloadContract.js";

interface PendingExportDownload {
  requestId: string;
  owner: WebContents;
  expectedFilename: string;
  targetPath: string;
  claimed: boolean;
  unclaimedTimer: ReturnType<typeof setTimeout>;
  cancelClaimedDownload?: () => void;
}

interface RevealEntry {
  owner: WebContents;
  filePath: string;
  expiresAt: number;
}

export interface ExportDownloadCoordinatorOptions {
  downloadsDirectory: string;
  unclaimedTimeoutMs?: number;
  revealTtlMs?: number;
  fileExists?: (filePath: string) => boolean;
  createId?: () => string;
  now?: () => number;
}

const FORMAT_EXTENSIONS: Record<ExportDownloadFormat, string> = {
  pdf: ".pdf",
  docx: ".docx",
  html: ".html",
  markdown: ".md",
  txt: ".txt",
};
const DEFAULT_UNCLAIMED_TIMEOUT_MS = 30_000;
const DEFAULT_REVEAL_TTL_MS = 10 * 60_000;
const MAX_FILENAME_LENGTH = 180;
const WINDOWS_RESERVED_DEVICE_STEM =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * 接管主窗口已登记的导出下载。未登记或不匹配的普通下载保持 Electron 默认行为。
 */
export class ExportDownloadCoordinator {
  private readonly pending = new Map<string, PendingExportDownload>();
  private readonly reservedPaths = new Set<string>();
  private readonly revealEntries = new Map<string, RevealEntry>();
  private readonly downloadsDirectory: string;
  private readonly unclaimedTimeoutMs: number;
  private readonly revealTtlMs: number;
  private readonly fileExists: (filePath: string) => boolean;
  private readonly createId: () => string;
  private readonly now: () => number;
  private disposed = false;

  private readonly onWillDownload = (
    event: ElectronEvent,
    item: DownloadItem,
    webContents: WebContents,
  ): void => {
    const pending = this.findMatchingPending(
      webContents,
      item.getFilename(),
      readRequestIdFromDownloadUrl(item.getURL()),
    );
    if (!pending) return;

    pending.claimed = true;
    clearTimeout(pending.unclaimedTimer);

    const onUpdated = (
      _event: ElectronEvent,
      state: "progressing" | "interrupted",
    ): void => {
      // interrupted 在 updated 阶段仍可能恢复，不能提前判失败；最终状态只认 done。
      if (state === "interrupted") {
        console.warn("[export-download] 下载暂时中断，等待 Electron 最终状态", {
          requestId: pending.requestId,
        });
      }
    };
    const onDone = (
      _event: ElectronEvent,
      state: "completed" | "cancelled" | "interrupted",
    ): void => {
      item.removeListener("updated", onUpdated);
      pending.cancelClaimedDownload = undefined;
      if (state === "completed" && this.fileExists(pending.targetPath)) {
        this.complete(pending);
        return;
      }
      const reason: ExportDownloadFailureReason =
        state === "completed" ? "missing-file" : state;
      this.fail(pending, reason);
    };

    item.on("updated", onUpdated);
    item.once("done", onDone);
    pending.cancelClaimedDownload = () => {
      item.removeListener("updated", onUpdated);
      item.removeListener("done", onDone);
      pending.cancelClaimedDownload = undefined;
      try {
        item.cancel();
      } catch {
        // 窗口销毁时 DownloadItem 可能已失效；清理监听器后无需继续抛错。
      }
    };
    try {
      item.setSavePath(pending.targetPath);
    } catch (error) {
      item.removeListener("updated", onUpdated);
      item.removeListener("done", onDone);
      pending.cancelClaimedDownload = undefined;
      event.preventDefault();
      console.error("[export-download] 设置导出保存路径失败", {
        requestId: pending.requestId,
        error,
      });
      this.fail(pending, "not-started");
    }
  };

  constructor(
    private readonly session: Session,
    options: ExportDownloadCoordinatorOptions,
  ) {
    this.downloadsDirectory = path.resolve(options.downloadsDirectory);
    this.unclaimedTimeoutMs = options.unclaimedTimeoutMs ?? DEFAULT_UNCLAIMED_TIMEOUT_MS;
    this.revealTtlMs = options.revealTtlMs ?? DEFAULT_REVEAL_TTL_MS;
    this.fileExists = options.fileExists ?? existsSync;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.session.on("will-download", this.onWillDownload);
  }

  register(
    owner: WebContents,
    input: unknown,
  ): ExportDownloadRegistration | null {
    if (this.disposed || owner.isDestroyed()) return null;
    const normalized = validateRegistrationInput(input);
    if (!normalized) return null;

    const requestId = this.createId();
    const targetPath = this.reserveTargetPath(normalized.filename);
    const unclaimedTimer = setTimeout(() => {
      const pending = this.pending.get(requestId);
      if (!pending || pending.claimed) return;
      this.fail(pending, "not-started");
    }, this.unclaimedTimeoutMs);
    unclaimedTimer.unref?.();

    this.pending.set(requestId, {
      requestId,
      owner,
      expectedFilename: normalized.filename,
      targetPath,
      claimed: false,
      unclaimedTimer,
    });
    return { requestId };
  }

  cancel(owner: WebContents, requestId: unknown): boolean {
    if (typeof requestId !== "string") return false;
    const pending = this.pending.get(requestId);
    if (!pending || pending.owner !== owner || pending.claimed) return false;
    clearTimeout(pending.unclaimedTimer);
    this.pending.delete(requestId);
    this.reservedPaths.delete(pending.targetPath);
    return true;
  }

  resolveRevealPath(owner: WebContents, token: unknown): string | null {
    if (typeof token !== "string" || token.length === 0) return null;
    this.cleanupExpiredRevealEntries();
    const entry = this.revealEntries.get(token);
    if (
      !entry ||
      entry.owner !== owner ||
      owner.isDestroyed() ||
      !this.fileExists(entry.filePath)
    ) {
      return null;
    }
    return entry.filePath;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.off("will-download", this.onWillDownload);
    for (const pending of [...this.pending.values()]) {
      pending.cancelClaimedDownload?.();
      this.fail(pending, "window-closed");
    }
    this.revealEntries.clear();
  }

  private findMatchingPending(
    owner: WebContents,
    filename: string,
    requestId: string | null,
  ): PendingExportDownload | null {
    if (!requestId) return null;
    for (const pending of this.pending.values()) {
      if (
        !pending.claimed &&
        pending.owner === owner &&
        pending.requestId === requestId &&
        pending.expectedFilename === filename
      ) {
        return pending;
      }
    }
    return null;
  }

  private reserveTargetPath(filename: string): string {
    const extension = path.extname(filename);
    const stem = filename.slice(0, -extension.length);
    let suffix = 1;
    while (true) {
      const candidateFilename =
        suffix === 1 ? filename : `${stem} (${suffix})${extension}`;
      const candidatePath = path.join(this.downloadsDirectory, candidateFilename);
      if (!this.fileExists(candidatePath) && !this.reservedPaths.has(candidatePath)) {
        this.reservedPaths.add(candidatePath);
        return candidatePath;
      }
      suffix += 1;
    }
  }

  private complete(pending: PendingExportDownload): void {
    this.pending.delete(pending.requestId);
    this.reservedPaths.delete(pending.targetPath);
    this.cleanupExpiredRevealEntries();
    const revealToken = this.createId();
    this.revealEntries.set(revealToken, {
      owner: pending.owner,
      filePath: pending.targetPath,
      expiresAt: this.now() + this.revealTtlMs,
    });
    this.sendResult(pending.owner, {
      requestId: pending.requestId,
      saved: true,
      filename: path.basename(pending.targetPath),
      revealToken,
    });
  }

  private fail(
    pending: PendingExportDownload,
    reason: ExportDownloadFailureReason,
  ): void {
    clearTimeout(pending.unclaimedTimer);
    this.pending.delete(pending.requestId);
    this.reservedPaths.delete(pending.targetPath);
    this.sendResult(pending.owner, {
      requestId: pending.requestId,
      saved: false,
      filename: path.basename(pending.targetPath),
      reason,
    });
  }

  private sendResult(owner: WebContents, result: ExportDownloadResult): void {
    try {
      if (owner.isDestroyed()) return;
      owner.send(EXPORT_DOWNLOAD_RESULT_CHANNEL, result);
    } catch {
      // renderer 与 done 事件可能同时销毁；结果无人接收时只做本地清理。
    }
  }

  private cleanupExpiredRevealEntries(): void {
    const now = this.now();
    for (const [token, entry] of this.revealEntries) {
      if (entry.expiresAt <= now) this.revealEntries.delete(token);
    }
  }
}

function readRequestIdFromDownloadUrl(downloadUrl: string): string | null {
  try {
    const hash = new URL(downloadUrl).hash.slice(1);
    const prefix = `${EXPORT_DOWNLOAD_REQUEST_FRAGMENT_KEY}=`;
    if (!hash.startsWith(prefix)) return null;
    const requestId = decodeURIComponent(hash.slice(prefix.length));
    return requestId.length > 0 ? requestId : null;
  } catch {
    return null;
  }
}

function validateRegistrationInput(
  input: unknown,
): ExportDownloadRegistrationInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { filename, format } = input as Record<string, unknown>;
  if (
    typeof filename !== "string" ||
    typeof format !== "string" ||
    !Object.hasOwn(FORMAT_EXTENSIONS, format)
  ) {
    return null;
  }
  const typedFormat = format as ExportDownloadFormat;
  const extension = path.extname(filename);
  const stem = filename.slice(0, -extension.length);
  if (
    filename.length === 0 ||
    filename.length > MAX_FILENAME_LENGTH ||
    filename !== filename.trim() ||
    path.isAbsolute(filename) ||
    path.posix.basename(filename) !== filename ||
    path.win32.basename(filename) !== filename ||
    /[\u0000-\u001f<>:"/\\|?*]/.test(filename) ||
    /[. ]$/.test(filename) ||
    extension.toLowerCase() !== FORMAT_EXTENSIONS[typedFormat] ||
    WINDOWS_RESERVED_DEVICE_STEM.test(stem)
  ) {
    return null;
  }
  return { filename, format: typedFormat };
}
