import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import {
  removeUnpairedSurrogates,
  UPLOAD_FILENAME_HEADER,
  UPLOAD_PURPOSE_HEADER,
  UPLOAD_SESSION_HEADER,
} from "@qingagent/contract-ts";
import {
  __resetDocumentsClientForTest,
} from "@qingagent/db/client";
import { __resetMigrationsForTest } from "@qingagent/db/migrations";

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
  return { app, uploadDir: storage.UPLOAD_DIR, storage };
}

async function seedUploadedFile(uploadDir: string, filename: string, content = "x") {
  const fileId = crypto.randomUUID();
  const dir = path.join(uploadDir, fileId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), content);
  const { ensureSessionResource } = await import("@qingagent/db");
  await ensureSessionResource({
    sessionId: "seeded-download-session",
    resourceId: fileId,
    kind: "discovered",
  });
  return fileId;
}

async function postUpload(
  app: Hono,
  input: {
    filename: string;
    content: string | Buffer;
    mimeType?: string;
    purpose?: "material";
    sessionId?: string;
  },
) {
  const content = Buffer.from(input.content);
  const res = await app.request("/api/v1/upload", {
    method: "POST",
    headers: {
      "Content-Type": input.mimeType ?? "application/octet-stream",
      [UPLOAD_FILENAME_HEADER]: encodeURIComponent(removeUnpairedSurrogates(input.filename)),
      ...(input.purpose ? { [UPLOAD_PURPOSE_HEADER]: input.purpose } : {}),
      [UPLOAD_SESSION_HEADER]: input.sessionId ?? "upload-route-session",
    },
    body: content,
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

async function uploadEntries(uploadDir: string): Promise<string[]> {
  return fs.readdir(uploadDir).catch(() => []);
}

async function deleteOwnedSessionAssets(sessionId: string): Promise<void> {
  const {
    beginSessionDeletion,
    deleteSessionDatabaseRowsAndAdvance,
    deleteSessionDocumentsAndAdvance,
    markSessionThreadsDeleted,
  } = await import("@qingagent/db");
  await beginSessionDeletion(sessionId);
  await deleteSessionDocumentsAndAdvance(sessionId);
  await markSessionThreadsDeleted(sessionId);
  await deleteSessionDatabaseRowsAndAdvance(sessionId, [`om-sidecar:${sessionId}`]);
  const { deleteSessionStoredResources } = await import(
    "../gateway/sessionStoredResources"
  );
  await deleteSessionStoredResources(sessionId);
}

describe("uploadRoutes 下载响应头", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qingagent-upload-route-"));
    process.chdir(tmpDir);
    process.env.DATABASE_URL = `file:${path.join(tmpDir, "qingagent.db")}`;
    __resetDocumentsClientForTest();
    __resetMigrationsForTest();
  });

  afterEach(async () => {
    __resetDocumentsClientForTest();
    __resetMigrationsForTest();
    delete process.env.DATABASE_URL;
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("html 文件强制 attachment 且 nosniff", async () => {
    const { app, uploadDir } = await createUploadApp();
    const fileId = await seedUploadedFile(uploadDir, "xss.html", "<script>alert(1)</script>");

    const res = await app.request(`/api/v1/files/${fileId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename=\"xss.html\"; filename*=UTF-8''xss.html",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("svg 文件强制 attachment 且 nosniff", async () => {
    const { app, uploadDir } = await createUploadApp();
    const fileId = await seedUploadedFile(uploadDir, "xss.svg", "<svg onload='alert(1)' />");

    const res = await app.request(`/api/v1/files/${fileId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename=\"xss.svg\"; filename*=UTF-8''xss.svg",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("白名单安全类型仍允许 inline", async () => {
    const { app, uploadDir } = await createUploadApp();
    const fileId = await seedUploadedFile(uploadDir, "report.pdf", "%PDF-1.4");

    const res = await app.request(`/api/v1/files/${fileId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      "inline; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("未知类型默认 attachment", async () => {
    const { app, uploadDir } = await createUploadApp();
    const fileId = await seedUploadedFile(uploadDir, "payload.bin", "bin");

    const res = await app.request(`/api/v1/files/${fileId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename=\"payload.bin\"; filename*=UTF-8''payload.bin",
    );
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

  it("会话进入删除态后，即使物理文件尚在，直接下载路由也拒绝访问", async () => {
    const { app } = await createUploadApp();
    const sessionId = "download-owner-delete";
    const uploaded = await postUpload(app, {
      filename: "删除后不可下载.txt",
      mimeType: "text/plain",
      content: "sensitive bytes",
      sessionId,
    });
    expect(uploaded.res.status).toBe(200);
    expect((await app.request(`/api/v1/files/${uploaded.body.fileId}`)).status).toBe(200);

    const { beginSessionDeletion } = await import("@qingagent/db");
    await beginSessionDeletion(sessionId);

    expect((await app.request(`/api/v1/files/${uploaded.body.fileId}`)).status).toBe(404);
  });

  it("素材 POST 确实发出后在返回 fileId 前拒绝 PNG 改名 DOCX，且不影响未声明用途的上传", async () => {
    const { app, uploadDir } = await createUploadApp();
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const materialUpload = await postUpload(app, {
      filename: "A-r6-fake-image.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      content: pngBytes,
      purpose: "material",
    });

    expect(materialUpload.res.status).toBe(422);
    expect(materialUpload.body).toEqual({
      error: "material_format_mismatch",
    });
    expect(await uploadDirs(uploadDir)).toEqual([]);

    const legacyConsumerUpload = await postUpload(app, {
      filename: "A-r6-fake-image.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      content: pngBytes,
    });
    expect(legacyConsumerUpload.res.status).toBe(200);
    expect(legacyConsumerUpload.body.fileId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("素材用途接受可读文本并返回可核验 fileId", async () => {
    const { app } = await createUploadApp();
    const uploaded = await postUpload(app, {
      filename: "brief.md",
      mimeType: "text/markdown",
      content: "# 可读素材\n",
      purpose: "material",
    });

    expect(uploaded.res.status).toBe(200);
    expect(uploaded.body).toMatchObject({
      filename: "brief.md",
      mimeType: "text/markdown",
      size: Buffer.byteLength("# 可读素材\n"),
    });
    expect(uploaded.body.fileId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("无扩展名文件下载时优先采用持久化 MIME", async () => {
    const { app } = await createUploadApp();
    const uploaded = await postUpload(app, {
      filename: "preview",
      mimeType: "application/pdf",
      content: "%PDF-1.4",
    });

    const res = await app.request(`/api/v1/files/${uploaded.body.fileId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("扩展名与持久化 MIME 不一致时按持久化 MIME 判定响应类型", async () => {
    const { app } = await createUploadApp();
    const uploaded = await postUpload(app, {
      filename: "renamed.txt",
      mimeType: "image/png",
      content: "png bytes",
    });

    const res = await app.request(`/api/v1/files/${uploaded.body.fileId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect(res.headers.get("content-disposition")).toContain("inline");
  });

  it("中文和空格文件名同时提供安全 ASCII fallback 与 UTF-8 filename*", async () => {
    const { app } = await createUploadApp();
    const uploaded = await postUpload(app, {
      filename: "项目 报告.pdf",
      mimeType: "application/pdf",
      content: "%PDF-1.4",
    });

    const res = await app.request(`/api/v1/files/${uploaded.body.fileId}`);

    expect(res.headers.get("content-disposition")).toBe(
      "inline; filename=\"_____.pdf\"; " +
      "filename*=UTF-8''%E9%A1%B9%E7%9B%AE%20%E6%8A%A5%E5%91%8A.pdf",
    );
  });

  it("孤立代理项不会令下载 500，非 BMP emoji 仍完整编码进 filename*", async () => {
    const { app } = await createUploadApp();
    const malformed = await postUpload(app, {
      filename: "坏\uD800名.txt",
      mimeType: "text/plain",
      content: "malformed filename",
    });
    const emoji = await postUpload(app, {
      filename: "发布🚀.pdf",
      mimeType: "application/pdf",
      content: "emoji filename",
    });

    const malformedDownload = await app.request(
      `/api/v1/files/${malformed.body.fileId}`,
    );
    const emojiDownload = await app.request(`/api/v1/files/${emoji.body.fileId}`);

    expect(malformedDownload.status).toBe(200);
    expect(malformedDownload.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%E5%9D%8F%E5%90%8D.txt",
    );
    expect(emojiDownload.status).toBe(200);
    expect(emojiDownload.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%E5%8F%91%E5%B8%83%F0%9F%9A%80.pdf",
    );
  });

  it("非法 MIME 参数与文件名控制字符不能污染下载响应头", async () => {
    const { app } = await createUploadApp();
    const uploaded = await postUpload(app, {
      filename: "报告\r\nX-Test: yes.txt",
      mimeType: "image/png; boundary=evil",
      content: "safe text",
    });

    const res = await app.request(`/api/v1/files/${uploaded.body.fileId}`);
    const contentDisposition = res.headers.get("content-disposition") ?? "";

    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(contentDisposition).not.toMatch(/[\r\n]/);
    expect(res.headers.has("x-test")).toBe(false);
  });

  it("两个会话共享同一 fileId 时，首个会话删除后另一个仍可下载，最后删除才移除文件", async () => {
    const { app } = await createUploadApp();
    const firstSessionUpload = await postUpload(app, {
      filename: "共享报告.pdf",
      mimeType: "application/pdf",
      content: "shared session bytes",
      sessionId: "shared-first-session",
    });
    const secondSessionUpload = await postUpload(app, {
      filename: "共享报告.pdf",
      mimeType: "application/pdf",
      content: "shared session bytes",
      sessionId: "shared-second-session",
    });

    expect(secondSessionUpload.body.fileId).toBe(firstSessionUpload.body.fileId);

    await deleteOwnedSessionAssets("shared-first-session");
    const stillDownloadable = await app.request(
      `/api/v1/files/${secondSessionUpload.body.fileId}`,
    );
    expect(stillDownloadable.status).toBe(200);
    await expect(stillDownloadable.text()).resolves.toBe("shared session bytes");

    await deleteOwnedSessionAssets("shared-second-session");
    const deleted = await app.request(`/api/v1/files/${secondSessionUpload.body.fileId}`);
    expect(deleted.status).toBe(404);
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

describe("uploadRoutes 二进制上传上限与元数据校验", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qingagent-upload-limit-"));
    process.chdir(tmpDir);
    process.env.DATABASE_URL = `file:${path.join(tmpDir, "qingagent.db")}`;
    __resetDocumentsClientForTest();
    __resetMigrationsForTest();
    process.env.QINGAGENT_UPLOAD_MAX_BYTES = "8";
  });

  afterEach(async () => {
    __resetDocumentsClientForTest();
    __resetMigrationsForTest();
    delete process.env.DATABASE_URL;
    delete process.env.QINGAGENT_UPLOAD_MAX_BYTES;
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("有 Content-Length 且请求体声明超限时直接返回稳定 413 契约", async () => {
    const { app, uploadDir } = await createUploadApp();
    const res = await app.request("/api/v1/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(80 * 1024),
        [UPLOAD_FILENAME_HEADER]: "big.bin",
        [UPLOAD_SESSION_HEADER]: "upload-limit-session",
      },
      body: Buffer.alloc(1),
    });

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "file_too_large", maxBytes: 8 });
    expect(await uploadEntries(uploadDir)).toEqual([]);
  });

  it("无 Content-Length 时按流累计，请求体超限仍返回稳定 413 契约", async () => {
    const { app, uploadDir } = await createUploadApp();
    const request = new Request("http://localhost/api/v1/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        [UPLOAD_FILENAME_HEADER]: "big.bin",
        [UPLOAD_SESSION_HEADER]: "upload-limit-session",
      },
      body: Buffer.alloc(9),
    });
    expect(request.headers.get("content-length")).toBeNull();

    const res = await app.request(request);

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "file_too_large", maxBytes: 8 });
    expect(await uploadEntries(uploadDir)).toEqual([]);
  });

  it("空文件拒绝为 400，且不落盘、不写索引", async () => {
    const { app, uploadDir } = await createUploadApp();
    const res = await app.request("/api/v1/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        [UPLOAD_FILENAME_HEADER]: "empty.bin",
        [UPLOAD_SESSION_HEADER]: "upload-limit-session",
      },
      body: new Uint8Array(),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "empty file" });
    expect(await uploadEntries(uploadDir)).toEqual([]);
  });

  it("配置上限的精确边界成功，上限加一稳定返回 413", async () => {
    const { app, uploadDir } = await createUploadApp();
    const atLimit = await postUpload(app, {
      filename: "eight.bin",
      content: "12345678",
    });
    expect(atLimit.res.status).toBe(200);
    expect(atLimit.body.size).toBe(8);

    const overLimit = await app.request("/api/v1/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        [UPLOAD_FILENAME_HEADER]: "nine.bin",
        [UPLOAD_SESSION_HEADER]: "upload-limit-session",
      },
      body: Buffer.alloc(9, 1),
    });
    expect(overLimit.status).toBe(413);
    await expect(overLimit.json()).resolves.toEqual({
      error: "file_too_large",
      maxBytes: 8,
    });
    expect(await uploadDirs(uploadDir)).toEqual([atLimit.body.fileId]);
  });

  it.each([
    ["缺文件名", {}],
    ["坏文件名编码", { [UPLOAD_FILENAME_HEADER]: "%E0%A4%A" }],
    ["非法用途", { [UPLOAD_FILENAME_HEADER]: "bad.bin", [UPLOAD_PURPOSE_HEADER]: "other" }],
  ])("%s 拒绝为 400", async (_name, metadataHeaders) => {
    const { app, uploadDir } = await createUploadApp();
    const res = await app.request("/api/v1/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        ...metadataHeaders,
      },
      body: Buffer.from("x"),
    });

    expect(res.status).toBe(400);
    expect(await uploadEntries(uploadDir)).toEqual([]);
  });
});
