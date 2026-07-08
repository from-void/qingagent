import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { diagnosticsRoutes } from "../routes/diagnostics";
import { collectLogs } from "../diagnostics/collect";

describe("diagnostics routes", () => {
  const savedLogDir = process.env.QINGAGENT_LOG_DIR;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "qingagent-diagnostics-"));
    process.env.QINGAGENT_LOG_DIR = dir;
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (savedLogDir === undefined) delete process.env.QINGAGENT_LOG_DIR;
    else process.env.QINGAGENT_LOG_DIR = savedLogDir;
    await rm(dir, { recursive: true, force: true });
  });

  it("usage 统计日志目录文件与总字节", async () => {
    await writeFile(path.join(dir, "main-2026-07-03.log"), "abc");
    await writeFile(path.join(dir, "spans-2026-07-03.jsonl"), "12345");
    await writeFile(path.join(dir, "nested"), "not-dir");

    const res = await app().request("/api/v1/diagnostics/usage");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      logsDir: dir,
      totalBytes: 15,
      files: [
        { name: "main-2026-07-03.log", bytes: 3 },
        { name: "nested", bytes: 7 },
        { name: "spans-2026-07-03.jsonl", bytes: 5 },
      ],
    });
  });

  it("usage 未设置日志目录时返回空占用", async () => {
    delete process.env.QINGAGENT_LOG_DIR;

    const res = await app().request("/api/v1/diagnostics/usage");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ logsDir: null, totalBytes: 0, files: [] });
  });

  it("collectLogs 收集 renderer 滚动日志", async () => {
    await writeFile(path.join(dir, "renderer-2026-07-04.log"), "[2026-07-04T00:00:00.000Z] [ERROR] boom\n");

    const logs = await collectLogs(dir);

    expect(logs.map((file) => file.path)).toContain("logs/renderer-2026-07-04.log");
  });

  it("clear 受 Origin 守卫，并保留当天滚动日志", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T12:00:00.000Z"));
    await writeFile(path.join(dir, "main-2026-07-04.log"), "today-main");
    await writeFile(path.join(dir, "spans-2026-07-04.jsonl"), "today-spans");
    await writeFile(path.join(dir, "server-2026-07-04.log"), "today-server");
    await writeFile(path.join(dir, "main-2026-07-03.log"), "old-main");
    await writeFile(path.join(dir, "spans-2026-07-02.jsonl"), "old-spans");
    await writeFile(path.join(dir, "server-2026-07-01.log"), "old-server");
    await writeFile(path.join(dir, "keep.txt"), "manual");

    const rejected = await app().request("/api/v1/diagnostics/clear", {
      method: "POST",
      headers: { Origin: "https://evil.test" },
    });
    expect(rejected.status).toBe(403);

    const res = await app().request("/api/v1/diagnostics/clear", { method: "POST" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      deleted: 3,
      freedBytes: "old-main".length + "old-spans".length + "old-server".length,
    });
    expect((await readdir(dir)).sort()).toEqual([
      "keep.txt",
      "main-2026-07-04.log",
      "server-2026-07-04.log",
      "spans-2026-07-04.jsonl",
    ]);
    await expect(readFile(path.join(dir, "main-2026-07-04.log"), "utf8")).resolves.toBe("today-main");
  });
});

function app(): Hono {
  const hono = new Hono();
  hono.route("/api/v1", diagnosticsRoutes);
  return hono;
}
