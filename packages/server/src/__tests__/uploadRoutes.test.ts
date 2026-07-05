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
});
