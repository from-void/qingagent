import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
import {
  type ExportDownloadFailureReason,
  type ExportDownloadFormat,
  type ExportDownloadSaveInput,
  type ExportDownloadSaveResult,
} from "../exportDownloadContract.js";

export {
  EXPORT_DOWNLOAD_REVEAL_CHANNEL,
  EXPORT_DOWNLOAD_SAVE_CHANNEL,
} from "../exportDownloadContract.js";
export type {
  ExportDownloadFailureReason,
  ExportDownloadFormat,
  ExportDownloadSaveInput,
  ExportDownloadSaveResult,
} from "../exportDownloadContract.js";

interface PendingExportSave {
  controller: AbortController;
  settleAbort: (reason: ExportDownloadFailureReason) => void;
}

interface RevealEntry {
  owner: WebContents;
  filePath: string;
  expiresAt: number;
}

interface WriteFileOptions {
  flag: "wx";
  signal: AbortSignal;
}

export interface ExportDownloadCoordinatorOptions {
  downloadsDirectory: string;
  saveTimeoutMs?: number;
  revealTtlMs?: number;
  fileExists?: (filePath: string) => boolean;
  createId?: () => string;
  now?: () => number;
  ensureDirectory?: (directory: string) => Promise<unknown>;
  writeFile?: (
    filePath: string,
    bytes: Uint8Array,
    options: WriteFileOptions,
  ) => Promise<unknown>;
  renameFile?: (from: string, to: string) => Promise<unknown>;
  removeFile?: (filePath: string) => Promise<unknown>;
}

const FORMAT_EXTENSIONS: Record<ExportDownloadFormat, string> = {
  pdf: ".pdf",
  docx: ".docx",
  html: ".html",
  markdown: ".md",
  txt: ".txt",
  zip: ".zip",
  png: ".png",
};
const DEFAULT_SAVE_TIMEOUT_MS = 30_000;
const DEFAULT_REVEAL_TTL_MS = 10 * 60_000;
const MAX_FILENAME_LENGTH = 180;
const WINDOWS_RESERVED_DEVICE_STEM =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * 将 renderer 已取得的导出字节直接写入 Downloads。保存不再经过 blob: 导航、
 * Chromium DownloadItem 或 will-download，因此不受 CSP、session 下载策略和窗口观察者影响。
 */
export class ExportDownloadCoordinator {
  private readonly pending = new Map<string, PendingExportSave>();
  private readonly reservedPaths = new Set<string>();
  private readonly reservedTempPaths = new Set<string>();
  private readonly revealEntries = new Map<string, RevealEntry>();
  private readonly downloadsDirectory: string;
  private readonly saveTimeoutMs: number;
  private readonly revealTtlMs: number;
  private readonly fileExists: (filePath: string) => boolean;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly ensureDirectory: (directory: string) => Promise<unknown>;
  private readonly writeFile: NonNullable<ExportDownloadCoordinatorOptions["writeFile"]>;
  private readonly renameFile: NonNullable<ExportDownloadCoordinatorOptions["renameFile"]>;
  private readonly removeFile: NonNullable<ExportDownloadCoordinatorOptions["removeFile"]>;
  private disposed = false;

  constructor(options: ExportDownloadCoordinatorOptions) {
    this.downloadsDirectory = path.resolve(options.downloadsDirectory);
    this.saveTimeoutMs = options.saveTimeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS;
    this.revealTtlMs = options.revealTtlMs ?? DEFAULT_REVEAL_TTL_MS;
    this.fileExists = options.fileExists ?? existsSync;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.ensureDirectory = options.ensureDirectory ?? ((directory) => (
      mkdir(directory, { recursive: true })
    ));
    this.writeFile = options.writeFile ?? ((filePath, bytes, writeOptions) => (
      writeFile(filePath, bytes, writeOptions)
    ));
    this.renameFile = options.renameFile ?? rename;
    this.removeFile = options.removeFile ?? unlink;
  }

  async save(owner: WebContents, input: unknown): Promise<ExportDownloadSaveResult> {
    const fallbackFilename = readFallbackFilename(input);
    if (this.disposed || owner.isDestroyed()) {
      return failure(fallbackFilename, "window-closed");
    }
    const normalized = validateSaveInput(input);
    if (!normalized) return failure(fallbackFilename, "not-started");

    try {
      await this.ensureDirectory(this.downloadsDirectory);
    } catch (error) {
      console.error("[export-download] 创建下载目录失败", { error });
      return failure(normalized.filename, "write-failed");
    }
    if (this.disposed || owner.isDestroyed()) {
      return failure(normalized.filename, "window-closed");
    }

    const pendingId = this.createId();
    const targetPath = this.reserveTargetPath(normalized.filename);
    const tempPath = this.reserveTempPath(pendingId);
    const controller = new AbortController();
    let settleAbort: PendingExportSave["settleAbort"] = () => undefined;
    const abortPromise = new Promise<ExportDownloadFailureReason>((resolve) => {
      settleAbort = resolve;
    });
    const pending: PendingExportSave = {
      controller,
      settleAbort,
    };
    this.pending.set(pendingId, pending);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let renamed = false;
    const writePromise = Promise.resolve().then(() => (
      this.writeFile(tempPath, normalized.bytes, {
        flag: "wx",
        signal: controller.signal,
      })
    ));
    const timeoutPromise = new Promise<ExportDownloadFailureReason>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, this.saveTimeoutMs);
      timeout.unref?.();
    });

    try {
      const outcome = await Promise.race([
        writePromise.then(() => "written" as const),
        timeoutPromise,
        abortPromise,
      ]);
      if (outcome !== "written") {
        controller.abort();
        this.cleanupTempAfterSettled(writePromise, tempPath);
        return failure(path.basename(targetPath), outcome);
      }
      if (this.disposed || owner.isDestroyed()) {
        await this.removeFileIfPresent(tempPath);
        return failure(path.basename(targetPath), "window-closed");
      }

      await this.renameFile(tempPath, targetPath);
      renamed = true;
      if (!this.fileExists(targetPath)) {
        return failure(path.basename(targetPath), "missing-file");
      }
      return this.complete(owner, targetPath);
    } catch (error) {
      const reason: ExportDownloadFailureReason =
        this.disposed || owner.isDestroyed() ? "window-closed" : "write-failed";
      console.error("[export-download] 写入导出文件失败", {
        filename: path.basename(targetPath),
        reason,
        error,
      });
      if (!renamed) await this.removeFileIfPresent(tempPath);
      return failure(path.basename(targetPath), reason);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.pending.delete(pendingId);
      this.reservedPaths.delete(targetPath);
      this.reservedTempPaths.delete(tempPath);
    }
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
    for (const pending of this.pending.values()) {
      pending.controller.abort();
      pending.settleAbort("window-closed");
    }
    this.revealEntries.clear();
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

  private reserveTempPath(initialId: string): string {
    let id = initialId;
    while (true) {
      const safeId = id.replace(/[^a-zA-Z0-9-]/g, "");
      const candidatePath = path.join(
        this.downloadsDirectory,
        `.qingagent-export-${safeId || randomUUID()}.tmp`,
      );
      if (!this.fileExists(candidatePath) && !this.reservedTempPaths.has(candidatePath)) {
        this.reservedTempPaths.add(candidatePath);
        return candidatePath;
      }
      id = this.createId();
    }
  }

  private complete(owner: WebContents, targetPath: string): ExportDownloadSaveResult {
    this.cleanupExpiredRevealEntries();
    const revealToken = this.createId();
    this.revealEntries.set(revealToken, {
      owner,
      filePath: targetPath,
      expiresAt: this.now() + this.revealTtlMs,
    });
    return {
      saved: true,
      filename: path.basename(targetPath),
      path: targetPath,
      revealToken,
    };
  }

  private cleanupTempAfterSettled(
    writePromise: Promise<unknown>,
    tempPath: string,
  ): void {
    void writePromise
      .catch(() => undefined)
      .then(() => this.removeFileIfPresent(tempPath));
  }

  private async removeFileIfPresent(filePath: string): Promise<void> {
    try {
      await this.removeFile(filePath);
    } catch {
      // 写入失败或超时后临时文件可能从未创建，清理保持静默。
    }
  }

  private cleanupExpiredRevealEntries(): void {
    const now = this.now();
    for (const [token, entry] of this.revealEntries) {
      if (entry.expiresAt <= now) this.revealEntries.delete(token);
    }
  }
}

function validateSaveInput(input: unknown): ExportDownloadSaveInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { filename, format, bytes } = input as Record<string, unknown>;
  if (
    typeof filename !== "string" ||
    typeof format !== "string" ||
    !(bytes instanceof Uint8Array) ||
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
  return { filename, format: typedFormat, bytes };
}

function readFallbackFilename(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "qingagent-export";
  }
  const filename = (input as Record<string, unknown>).filename;
  return typeof filename === "string" && filename.length > 0
    ? filename
    : "qingagent-export";
}

function failure(
  filename: string,
  reason: ExportDownloadFailureReason,
): ExportDownloadSaveResult {
  return { saved: false, filename, reason };
}
