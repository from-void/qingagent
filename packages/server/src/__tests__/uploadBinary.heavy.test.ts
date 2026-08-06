import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import {
  UPLOAD_FILENAME_HEADER,
  UPLOAD_SESSION_HEADER,
} from "@qingagent/contract-ts";
import { __resetDocumentsClientForTest } from "@qingagent/db/client";
import { __resetMigrationsForTest } from "@qingagent/db/migrations";

const originalCwd = process.cwd();
const FILE_BYTES = 100 * 1024 * 1024;
let tmpDir: string;

describe("100 MiB 二进制上传回归", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qingagent-upload-binary-heavy-"));
    process.chdir(tmpDir);
    process.env.DATABASE_URL = `file:${path.join(tmpDir, "qingagent.db")}`;
    __resetDocumentsClientForTest();
    __resetMigrationsForTest();
    process.env.QINGAGENT_UPLOAD_MAX_BYTES = String(128 * 1024 * 1024);
  });

  afterEach(async () => {
    __resetDocumentsClientForTest();
    __resetMigrationsForTest();
    delete process.env.DATABASE_URL;
    delete process.env.QINGAGENT_UPLOAD_MAX_BYTES;
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("原始请求体完整落盘，不经过 base64 膨胀", async () => {
    vi.resetModules();
    const [{ uploadRoutes }, { UPLOAD_DIR }] = await Promise.all([
      import("../routes/upload"),
      import("../lib/uploadStorage"),
    ]);
    const app = new Hono();
    app.route("/api/v1", uploadRoutes);
    const content = Buffer.alloc(FILE_BYTES, 0x5a);

    const response = await app.request("/api/v1/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        [UPLOAD_FILENAME_HEADER]: "memory-100m.bin",
        [UPLOAD_SESSION_HEADER]: "upload-binary-heavy-session",
      },
      body: content,
    });

    expect(response.status).toBe(200);
    const uploaded = await response.json() as { fileId: string; size: number };
    expect(uploaded.size).toBe(FILE_BYTES);
    const storedPath = path.join(UPLOAD_DIR, uploaded.fileId, "memory-100m.bin");
    await expect(fs.stat(storedPath)).resolves.toMatchObject({ size: FILE_BYTES });
    const handle = await fs.open(storedPath, "r");
    try {
      const edges = Buffer.alloc(2);
      await handle.read(edges, 0, 1, 0);
      await handle.read(edges, 1, 1, FILE_BYTES - 1);
      expect([...edges]).toEqual([0x5a, 0x5a]);
    } finally {
      await handle.close();
    }
  });
});
