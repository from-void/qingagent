import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const originalCwd = process.cwd();
let tmpDir: string;

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function loadStorage() {
  vi.resetModules();
  return import("../lib/uploadStorage");
}

describe("uploadStorage", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qingagent-upload-storage-"));
    process.chdir(tmpDir);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects unsafe upload ids without deleting the upload root", async () => {
    const storage = await loadStorage();
    await fs.mkdir(storage.UPLOAD_DIR, { recursive: true });
    const marker = path.join(storage.UPLOAD_DIR, "root-marker.txt");
    await fs.writeFile(marker, "keep");

    const invalidIds = [
      "",
      ".",
      "../x",
      "not-a-uuid",
      `${crypto.randomUUID()}/x`,
      `${crypto.randomUUID()}\\x`,
    ];

    for (const fileId of invalidIds) {
      expect(storage.isValidUploadId(fileId)).toBe(false);
      await expect(storage.deleteUploadedFile(fileId)).resolves.toBe(false);
      await expect(pathExists(storage.UPLOAD_DIR)).resolves.toBe(true);
      await expect(pathExists(marker)).resolves.toBe(true);
    }
  });

  it("keeps a valid but unindexed upload directory because its reference count is unknown", async () => {
    const storage = await loadStorage();
    const fileId = crypto.randomUUID();
    const uploadDir = path.join(storage.UPLOAD_DIR, fileId);
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, "source.txt"), "content");

    expect(storage.isValidUploadId(fileId)).toBe(true);
    await expect(storage.deleteUploadedFile(fileId)).resolves.toBe(true);
    await expect(pathExists(uploadDir)).resolves.toBe(true);
    await expect(pathExists(storage.UPLOAD_DIR)).resolves.toBe(true);
  });

  it("decrements shared upload references and deletes the physical file only after the last release", async () => {
    const storage = await loadStorage();
    const buffer = Buffer.from("same bytes");
    const first = await storage.findOrStoreUploadedFile({
      filename: "report.pdf",
      mimeType: "application/pdf",
      buffer,
    });
    const second = await storage.findOrStoreUploadedFile({
      filename: "report.pdf",
      mimeType: "application/pdf",
      buffer,
    });
    const firstUploadDir = path.join(storage.UPLOAD_DIR, first.record.fileId);

    expect(second).toMatchObject({
      deduped: true,
      record: { fileId: first.record.fileId, refCount: 2 },
    });
    await expect(storage.deleteUploadedFile(first.record.fileId)).resolves.toBe(true);
    await expect(pathExists(firstUploadDir)).resolves.toBe(true);

    let rawIndex = await fs.readFile(path.join(storage.UPLOAD_DIR, ".content-index.json"), "utf8");
    let index = JSON.parse(rawIndex) as {
      records: Record<string, { fileId: string; refCount?: number }>;
    };
    expect(Object.values(index.records)).toContainEqual(
      expect.objectContaining({ fileId: first.record.fileId, refCount: 1 }),
    );

    await expect(storage.deleteUploadedFile(second.record.fileId)).resolves.toBe(true);
    await expect(pathExists(firstUploadDir)).resolves.toBe(false);

    rawIndex = await fs.readFile(path.join(storage.UPLOAD_DIR, ".content-index.json"), "utf8");
    index = JSON.parse(rawIndex) as {
      records: Record<string, { fileId: string; refCount?: number }>;
    };
    expect(Object.values(index.records).some((record) => record.fileId === first.record.fileId)).toBe(false);

    const reuploaded = await storage.findOrStoreUploadedFile({
      filename: "report.pdf",
      mimeType: "application/pdf",
      buffer,
    });

    expect(reuploaded.deduped).toBe(false);
    expect(reuploaded.record.fileId).not.toBe(first.record.fileId);
    expect(reuploaded.record.refCount).toBe(1);
    await expect(pathExists(path.join(storage.UPLOAD_DIR, reuploaded.record.fileId, "report.pdf"))).resolves.toBe(true);
  });

  it("removes a legacy index record without refCount but keeps its physical file", async () => {
    const storage = await loadStorage();
    const fileId = crypto.randomUUID();
    const filename = "legacy.pdf";
    const content = Buffer.from("legacy bytes");
    const contentHash = storage.contentHashOf(content);
    const uploadDir = path.join(storage.UPLOAD_DIR, fileId);
    const indexPath = path.join(storage.UPLOAD_DIR, ".content-index.json");
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, filename), content);
    await fs.writeFile(
      indexPath,
      JSON.stringify({
        version: 1,
        complete: true,
        records: {
          [contentHash]: {
            fileId,
            filename,
            mimeType: "application/pdf",
            size: content.length,
            contentHash,
          },
        },
      }),
    );

    await expect(storage.deleteUploadedFile(fileId)).resolves.toBe(true);

    await expect(pathExists(uploadDir)).resolves.toBe(true);
    const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
      records: Record<string, { fileId: string }>;
    };
    expect(Object.values(index.records).some((record) => record.fileId === fileId)).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      "[uploadStorage] Upload refCount is unknown; removed index record but kept physical file for manual or GC cleanup",
      { fileId },
    );
  });
});
