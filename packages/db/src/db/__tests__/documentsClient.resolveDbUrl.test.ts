import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDbUrl } from "../documentsClient.js";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  vi.restoreAllMocks();
});

describe("resolveDbUrl", () => {
  it("未显式配置时不受 cwd 变化影响，并固定落在用户数据目录", () => {
    delete process.env.DATABASE_URL;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const first = resolveDbUrl();

    process.chdir("/tmp");
    const second = resolveDbUrl();

    expect(first).toBe(pathToFileURL(join(homedir(), ".qingagent", "qingagent.db")).href);
    expect(second).toBe(first);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.stringContaining(join(homedir(), ".qingagent", "qingagent.db")));
  });

  it("显式 DATABASE_URL 原样优先于默认位置", () => {
    process.env.DATABASE_URL = "libsql://configured.example.test";
    expect(resolveDbUrl()).toBe("libsql://configured.example.test");
  });
});
