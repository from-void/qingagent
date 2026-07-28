import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "QINGAGENT_DATA_DIR",
  "QINGAGENT_SANDBOX_DIR",
  "QINGAGENT_SANDBOX_BIN_DIR",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("sandboxPaths 启动期配置校验", () => {
  it("接受 dataDir 内的自定义沙箱与 CLI 目录", async () => {
    const dataDir = resolve(tmpdir(), "qingagent-sandbox-paths-data");
    process.env.QINGAGENT_DATA_DIR = dataDir;
    process.env.QINGAGENT_SANDBOX_DIR = join(dataDir, "custom-sessions");
    process.env.QINGAGENT_SANDBOX_BIN_DIR = join(dataDir, "custom-bin");
    vi.resetModules();

    const paths = await import("../workspace/sandboxPaths.js");

    expect(paths.SANDBOX_SESSIONS_BASE).toBe(join(dataDir, "custom-sessions"));
    expect(paths.SANDBOX_BIN_DIR).toBe(join(dataDir, "custom-bin"));
  });

  it("拒绝 dataDir 外及同前缀兄弟目录并记录回退日志", async () => {
    const dataDir = resolve(tmpdir(), "qingagent-sandbox-paths-data");
    process.env.QINGAGENT_DATA_DIR = dataDir;
    process.env.QINGAGENT_SANDBOX_DIR = resolve(tmpdir(), "qingagent-external-sessions");
    process.env.QINGAGENT_SANDBOX_BIN_DIR = join(`${dataDir}-sibling`, "bin");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();

    const paths = await import("../workspace/sandboxPaths.js");

    expect(paths.SANDBOX_SESSIONS_BASE).toBe(join(paths.QINGAGENT_DATA_DIR, "sessions"));
    expect(paths.SANDBOX_BIN_DIR).toBe(join(paths.QINGAGENT_DATA_DIR, "bin"));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining("QINGAGENT_SANDBOX_DIR"),
      expect.stringContaining("QINGAGENT_SANDBOX_BIN_DIR"),
    ]);
  });

  it.each([
    ["QINGAGENT_SANDBOX_DIR", "sessions"] as const,
    ["QINGAGENT_SANDBOX_BIN_DIR", "bin"] as const,
  ])("%s 经 dataDir 内符号链接逃逸时告警并回退", async (envName, fallbackName) => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-sandbox-paths-symlink-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const outside = join(root, "outside");
    const link = join(dataDir, "outside-link");
    await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(outside, { recursive: true })]);
    await symlink(outside, link);
    process.env.QINGAGENT_DATA_DIR = dataDir;
    process.env[envName] = join(link, "not-created-yet");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();

    const paths = await import("../workspace/sandboxPaths.js");

    const actual = envName === "QINGAGENT_SANDBOX_DIR"
      ? paths.SANDBOX_SESSIONS_BASE
      : paths.SANDBOX_BIN_DIR;
    expect(actual).toBe(join(dataDir, fallbackName));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(envName);
  });
});
