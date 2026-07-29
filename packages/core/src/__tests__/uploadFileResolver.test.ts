import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalUploadsDir = process.env.QINGAGENT_UPLOADS_DIR;
let tmpDir: string;

async function loadResolver() {
  vi.resetModules();
  return import("../session/uploadFileResolver.js");
}

describe("uploadFileResolver", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qingagent-upload-resolver-"));
    process.env.QINGAGENT_UPLOADS_DIR = path.join(tmpDir, "uploads");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    if (originalUploadsDir === undefined) {
      delete process.env.QINGAGENT_UPLOADS_DIR;
    } else {
      process.env.QINGAGENT_UPLOADS_DIR = originalUploadsDir;
    }
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("只解析 UUID uploads 目录内的真实文件", async () => {
    const resolver = await loadResolver();
    const fileId = crypto.randomUUID();
    const uploadDir = path.join(resolver.UPLOADS_BASE, fileId);
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, "report.pdf"), "pdf");

    const result = await resolver.resolveFileIds([fileId]);

    expect(result).toEqual([
      {
        fileId,
        filename: "report.pdf",
        filePath: await fs.realpath(path.join(uploadDir, "report.pdf")),
        mimeType: "application/pdf",
      },
    ]);
  });

  it("跳过路径穿越、绝对路径、非 UUID 和非字符串 fileId", async () => {
    const resolver = await loadResolver();
    await fs.mkdir(resolver.UPLOADS_BASE, { recursive: true });

    const result = await resolver.resolveFileIds([
      "../secret",
      "/tmp/secret",
      "not-a-uuid",
      42,
    ]);

    expect(result).toEqual([]);
    expect(console.warn).toHaveBeenCalledTimes(4);
  });

  it("上传目录缺失时日志不暴露宿主绝对路径或完整内部错误", async () => {
    const resolver = await loadResolver();
    const fileId = crypto.randomUUID();
    await fs.mkdir(resolver.UPLOADS_BASE, { recursive: true });

    const result = await resolver.resolveFileIds([fileId]);
    const serialized = JSON.stringify(vi.mocked(console.warn).mock.calls);

    expect(result).toEqual([]);
    expect(serialized).toContain('"errorCode":"ENOENT"');
    expect(serialized).not.toContain(resolver.UPLOADS_BASE);
    expect(serialized).not.toContain("no such file or directory");
  });

  it("拒绝 realpath 逃出 uploads 的符号链接目录", async () => {
    const resolver = await loadResolver();
    const fileId = crypto.randomUUID();
    const outsideDir = path.join(tmpDir, "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret");
    await fs.mkdir(resolver.UPLOADS_BASE, { recursive: true });
    await fs.symlink(outsideDir, path.join(resolver.UPLOADS_BASE, fileId), "dir");

    const result = await resolver.resolveFileIds([fileId]);

    expect(result).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      "[uploadFileResolver] 跳过不安全或不可用的上传文件",
      expect.objectContaining({
        fileIdHash: crypto.createHash("sha256").update(fileId).digest("hex").slice(0, 12),
        reason: "上传目录 realpath 不在 uploads 根目录内",
      }),
    );
  });

  it("拒绝 realpath 逃出 uploads 的符号链接文件", async () => {
    const resolver = await loadResolver();
    const fileId = crypto.randomUUID();
    const outsideFile = path.join(tmpDir, "secret.txt");
    await fs.writeFile(outsideFile, "secret");
    const uploadDir = path.join(resolver.UPLOADS_BASE, fileId);
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.symlink(outsideFile, path.join(uploadDir, "safe-name.txt"));

    const result = await resolver.resolveFileIds([fileId]);

    expect(result).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      "[uploadFileResolver] 跳过不安全或不可用的上传文件",
      expect.objectContaining({
        fileIdHash: crypto.createHash("sha256").update(fileId).digest("hex").slice(0, 12),
        reason: "上传文件 realpath 不在 uploads 根目录内",
      }),
    );
  });
});
