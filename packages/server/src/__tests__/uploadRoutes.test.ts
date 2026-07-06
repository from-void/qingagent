import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

const originalCwd = process.cwd();
let tmpDir: string;

async function createUploadApp() {
  vi.resetModules();
  const [{ uploadRoutes }, storage] = await Promise.all([
    import("../routes/upload"),
    import("../lib/uploadStorage"),
  ]);
  const app = new Hono();
  app.route("/api/v1", uploadRoutes);
  return { app, uploadDir: storage.UPLOAD_DIR };
}

async function seedUploadedFile(uploadDir: string, filename: string, content = "x") {
  const fileId = crypto.randomUUID();
  const dir = path.join(uploadDir, fileId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), content);
  return fileId;
}

async function postUpload(
  app: Hono,
  input: { filename: string; content: string; mimeType?: string },
) {
  const res = await app.request("/api/v1/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: input.filename,
      mimeType: input.mimeType,
      content: Buffer.from(input.content).toString("base64"),
    }),
  });
  return {
    res,
    body: await res.json() as {
      fileId: string;
      filename: string;
      mimeType: string;
      size: number;
    },
  };
}

async function uploadDirs(uploadDir: string): Promise<string[]> {
  const entries = await fs.readdir(uploadDir).catch(() => []);
  return entries.filter((entry) => /^[0-9a-f-]{36}$/i.test(entry)).sort();
}

describe("uploadRoutes 下载响应头", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qingagent-upload-route-"));
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("html 文件强制 attachment 且 nosniff", async () => {
    const { app, uploadDir } = await createUploadApp();
    const fileId = await seedUploadedFile(uploadDir, "xss.html", "<script>alert(1)</script>");

    const res = await app.request(`/api/v1/files/${fileId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="xss.html"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("svg 文件强制 attachment 且 nosniff", async () => {
    const { app, uploadDir } = await createUploadApp();
    const fileId = await seedUploadedFile(uploadDir, "xss.svg", "<svg onload='alert(1)' />");

    const res = await app.request(`/api/v1/files/${fileId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="xss.svg"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("白名单安全类型仍允许 inline", async () => {
    const { app, uploadDir } = await createUploadApp();
    const fileId = await seedUploadedFile(uploadDir, "report.pdf", "%PDF-1.4");

    const res = await app.request(`/api/v1/files/${fileId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="report.pdf"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("未知类型默认 attachment", async () => {
    const { app, uploadDir } = await createUploadApp();
    const fileId = await seedUploadedFile(uploadDir, "payload.bin", "bin");

    const res = await app.request(`/api/v1/files/${fileId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="payload.bin"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("同一份 content 连传两次复用同一个 fileId 且只落一个上传目录", async () => {
    const { app, uploadDir } = await createUploadApp();

    const first = await postUpload(app, {
      filename: "逐宁简历.pdf",
      mimeType: "application/pdf",
      content: "same pdf bytes",
    });
    const second = await postUpload(app, {
      filename: "逐宁简历.pdf",
      mimeType: "application/pdf",
      content: "same pdf bytes",
    });

    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(second.body.fileId).toBe(first.body.fileId);
    expect(second.body.filename).toBe("逐宁简历.pdf");
    expect(await uploadDirs(uploadDir)).toEqual([first.body.fileId]);
  });

  it("同 content 但文件名或 MIME 不同时不复用旧 record，避免解析类型被旧文件污染", async () => {
    const { app, uploadDir } = await createUploadApp();

    const first = await postUpload(app, {
      filename: "data.bin",
      mimeType: "application/octet-stream",
      content: "same bytes but different identity",
    });
    const second = await postUpload(app, {
      filename: "report.pdf",
      mimeType: "application/pdf",
      content: "same bytes but different identity",
    });

    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(second.body.fileId).not.toBe(first.body.fileId);
    expect(second.body.filename).toBe("report.pdf");
    expect(second.body.mimeType).toBe("application/pdf");
    expect(await uploadDirs(uploadDir)).toEqual([first.body.fileId, second.body.fileId].sort());
  });

  it("索引缺失时会扫描旧上传目录，同 content 返回旧 fileId 而不是追加新目录", async () => {
    const { app, uploadDir } = await createUploadApp();
    const oldFileId = await seedUploadedFile(uploadDir, "逐宁简历.pdf", "legacy bytes");

    const uploaded = await postUpload(app, {
      filename: "逐宁简历.pdf",
      mimeType: "application/pdf",
      content: "legacy bytes",
    });

    expect(uploaded.res.status).toBe(200);
    expect(uploaded.body.fileId).toBe(oldFileId);
    expect(await uploadDirs(uploadDir)).toEqual([oldFileId]);
  });

  it("索引指向缺失原文件时忽略 stale 记录并创建新的可用上传", async () => {
    const { app, uploadDir } = await createUploadApp();
    const missingFileId = crypto.randomUUID();
    const contentHash = crypto.createHash("sha256").update("stale bytes").digest("hex");
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(
      path.join(uploadDir, ".content-index.json"),
      JSON.stringify({
        version: 1,
        complete: true,
        records: {
          [contentHash]: {
            fileId: missingFileId,
            filename: "missing.pdf",
            mimeType: "application/pdf",
            size: "stale bytes".length,
            contentHash,
          },
        },
      }),
    );

    const uploaded = await postUpload(app, {
      filename: "逐宁简历.pdf",
      mimeType: "application/pdf",
      content: "stale bytes",
    });

    expect(uploaded.res.status).toBe(200);
    expect(uploaded.body.fileId).not.toBe(missingFileId);
    expect(await uploadDirs(uploadDir)).toEqual([uploaded.body.fileId]);
  });
});
