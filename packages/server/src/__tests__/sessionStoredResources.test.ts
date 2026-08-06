import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  __resetDocumentsClientForTest,
  getDocumentsClient,
} from "@qingagent/db/client";
import { __resetMigrationsForTest, ensureMigrated } from "@qingagent/db/migrations";
import { registerSessionResource } from "@qingagent/db";

const originalCwd = process.cwd();
const originalUploadsDir = process.env.QINGAGENT_UPLOADS_DIR;
let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qingagent-session-assets-"));
  process.chdir(tempDir);
  process.env.QINGAGENT_UPLOADS_DIR = path.join(tempDir, "uploads");
  process.env.DATABASE_URL = `file:${path.join(tempDir, "qingagent.db")}`;
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  await ensureMigrated();
});

afterEach(async () => {
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  delete process.env.DATABASE_URL;
  if (originalUploadsDir === undefined) delete process.env.QINGAGENT_UPLOADS_DIR;
  else process.env.QINGAGENT_UPLOADS_DIR = originalUploadsDir;
  process.chdir(originalCwd);
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("会话文件资源删除", () => {
  it("未进入上传索引的 agent 产出图也按完备清单物理删除", async () => {
    const sessionId = "generated-image-delete";
    const imageId = crypto.randomUUID();
    const imageDir = path.join(tempDir, "uploads", imageId);
    await fs.mkdir(imageDir, { recursive: true });
    await fs.writeFile(path.join(imageDir, "generated-image.svg"), "<svg />");
    await registerSessionResource({
      sessionId,
      resourceId: imageId,
      kind: "generated",
    });
    await getDocumentsClient().execute({
      sql: `INSERT INTO deleted_sessions (
        session_id, phase, created_at, updated_at, completed_at
      ) VALUES (?, 'database_deleted', ?, ?, NULL)`,
      args: [sessionId, "2026-08-06T00:00:00.000Z", "2026-08-06T00:00:00.000Z"],
    });

    const { deleteSessionStoredResources } = await import(
      "../gateway/sessionStoredResources"
    );
    await deleteSessionStoredResources(sessionId);

    await expect(fs.stat(imageDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
