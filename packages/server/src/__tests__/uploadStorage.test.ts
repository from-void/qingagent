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

  it("deletes only the directory for a valid upload UUID", async () => {
    const storage = await loadStorage();
    const fileId = crypto.randomUUID();
    const uploadDir = path.join(storage.UPLOAD_DIR, fileId);
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, "source.txt"), "content");

    expect(storage.isValidUploadId(fileId)).toBe(true);
    await expect(storage.deleteUploadedFile(fileId)).resolves.toBe(true);
    await expect(pathExists(uploadDir)).resolves.toBe(false);
    await expect(pathExists(storage.UPLOAD_DIR)).resolves.toBe(true);
  });

  it("deletes indexed uploads, prunes the content index, and reuploads same content with a new id", async () => {
    const storage = await loadStorage();
    const buffer = Buffer.from("same bytes");
    const first = await storage.findOrStoreUploadedFile({
      filename: "report.pdf",
      mimeType: "application/pdf",
      buffer,
    });
    const firstUploadDir = path.join(storage.UPLOAD_DIR, first.record.fileId);

    await expect(storage.deleteUploadedFile(first.record.fileId)).resolves.toBe(true);
    await expect(pathExists(firstUploadDir)).resolves.toBe(false);

    const rawIndex = await fs.readFile(path.join(storage.UPLOAD_DIR, ".content-index.json"), "utf8");
    const index = JSON.parse(rawIndex) as {
      records: Record<string, { fileId: string }>;
    };
    expect(Object.values(index.records).some((record) => record.fileId === first.record.fileId)).toBe(false);

    const second = await storage.findOrStoreUploadedFile({
      filename: "report.pdf",
      mimeType: "application/pdf",
      buffer,
    });

    expect(second.deduped).toBe(false);
    expect(second.record.fileId).not.toBe(first.record.fileId);
    await expect(pathExists(path.join(storage.UPLOAD_DIR, second.record.fileId, "report.pdf"))).resolves.toBe(true);
  });
});
