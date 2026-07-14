import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { decodeBase64 } from "../lib/base64";

const originalCwd = process.cwd();
const BASE64_70_MIB_CHARS = 70 * 1024 * 1024;
let tmpDir: string;

describe("大 base64 回归", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qingagent-upload-base64-heavy-"));
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    delete process.env.QINGAGENT_UPLOAD_MAX_BYTES;
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("线性校验并解码 70 MiB 合法 base64 字符串，不触发调用栈溢出", () => {
    const decodedBytes = BASE64_70_MIB_CHARS / 4 * 3;
    const content = Buffer.alloc(decodedBytes, 0x5a).toString("base64");

    expect(content).toHaveLength(BASE64_70_MIB_CHARS);
    const decoded = decodeBase64(content);
    expect(decoded?.byteLength).toBe(decodedBytes);
    expect(decoded?.[0]).toBe(0x5a);
    expect(decoded?.[decodedBytes - 1]).toBe(0x5a);
  });

  it("70 MiB 字符串尾部含非法字符时路由稳定返回 400", async () => {
    process.env.QINGAGENT_UPLOAD_MAX_BYTES = String(56 * 1024 * 1024);
    vi.resetModules();
    const { uploadRoutes } = await import("../routes/upload");
    const app = new Hono();
    app.route("/api/v1", uploadRoutes);
    const content = `${"A".repeat(BASE64_70_MIB_CHARS - 1)}!`;

    const response = await app.request("/api/v1/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "bad.bin", content }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_base64" });
  });
});
