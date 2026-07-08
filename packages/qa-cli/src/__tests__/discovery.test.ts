import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverInstance } from "../discovery.js";
import { QaCliError } from "../errors.js";

const originalFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("discoverInstance", () => {
  it("文件不存在时返回 NO_INSTANCE", async () => {
    await expect(discoverInstance(path.join(os.tmpdir(), "qa-missing-instance.json"))).rejects.toMatchObject({
      code: "NO_INSTANCE",
    });
  });

  it("pid 死亡时返回 NO_INSTANCE", async () => {
    const file = await writeInstance({ pid: 99999999, port: 1, token: "t" });
    await expect(discoverInstance(file)).rejects.toMatchObject({ code: "NO_INSTANCE" });
  });

  it("health 401 时返回 AUTH_FAILED", async () => {
    const file = await writeInstance({ pid: process.pid, port: 12345, token: "t" });
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 401 })) as typeof fetch;
    await expect(discoverInstance(file)).rejects.toBeInstanceOf(QaCliError);
    await expect(discoverInstance(file)).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
});

async function writeInstance(input: { pid: number; port: number; token: string }): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-cli-test-"));
  dirs.push(dir);
  const file = path.join(dir, "instance.json");
  await writeFile(file, JSON.stringify({
    ...input,
    version: "0.1.0",
    startedAt: new Date().toISOString(),
  }));
  return file;
}
