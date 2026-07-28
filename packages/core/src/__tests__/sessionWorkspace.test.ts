import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTools, Workspace, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import type { FolderSourceRecord } from "@qingagent/contract-ts";
import {
  __resetIsolationCacheForTest,
  __resetSessionWorkspaceCacheForTest,
  __sessionWorkspaceCacheStatsForTest,
  acquireSessionWorkspace,
  allowUnisolatedCommands,
  buildSandboxEnv,
  cleanupSessionWorkspace,
  getSessionWorkspace,
  invalidateSessionWorkspace,
  resolveIsolation,
  sandboxExtraReadOnlyPaths,
  sessionWorkspaceDir,
  sessionWorkspaceDirName,
  shouldInjectCredentials,
} from "../workspace/sessionWorkspace.js";

// 沙箱 P0:会话级 Workspace 装配——目录命名防穿越/最小 env/隔离解析/实例缓存

describe("sessionWorkspaceDirName 路径安全", () => {
  it("所有 sessionId 统一编码为固定长度的安全目录名", () => {
    expect(sessionWorkspaceDirName("9e01e165-1337-43f2-9383-cf339a82b60c")).toMatch(
      /^sid_[0-9a-f]{64}$/,
    );
    expect(sessionWorkspaceDirName("sess_attack-01")).toMatch(/^sid_[0-9a-f]{64}$/);
  });
  it("63/256 字符及 Unicode sessionId 均不会超过文件系统单组件长度", () => {
    const root = mkdtempSync(join(tmpdir(), "qingagent-session-dir-name-"));
    try {
      const sessionIds = [
        "a".repeat(63),
        "b".repeat(256),
        "会话🌏".repeat(64),
      ];
      const names = sessionIds.map(sessionWorkspaceDirName);

      expect(new Set(names).size).toBe(sessionIds.length);
      for (const name of names) {
        expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
        expect(() => mkdirSync(join(root, name))).not.toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("路径穿越字符不会进入目录名", () => {
    const name = sessionWorkspaceDirName("../../etc/passwd");
    expect(name).toMatch(/^sid_[0-9a-f]+$/);
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");

    expect(sessionWorkspaceDirName("a/b\\c:d")).toMatch(/^sid_[0-9a-f]+$/);
  });
  it("清洗后相同的恶意 sessionId 不会碰撞", () => {
    const names = [
      sessionWorkspaceDirName("sess/attack"),
      sessionWorkspaceDirName("sess\\attack"),
      sessionWorkspaceDirName("sess.attack"),
      sessionWorkspaceDirName("sess attack"),
    ];

    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^sid_[0-9a-f]+$/);
      expect(name).not.toContain("..");
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
    }
  });
  it("非法字符分支的旧输出不能与合法 sessionId 原值碰撞", () => {
    const unsafeSessionId = "sess/attack";
    const collidingSafeSessionId = `sess_attack_${
      createHash("sha256").update(unsafeSessionId).digest("hex").slice(0, 12)
    }`;

    expect(sessionWorkspaceDirName(unsafeSessionId)).not.toBe(
      sessionWorkspaceDirName(collidingSafeSessionId),
    );
    expect(sessionWorkspaceDir(unsafeSessionId)).not.toBe(
      sessionWorkspaceDir(collidingSafeSessionId),
    );
  });
  it("空串也走统一编码", () => {
    expect(sessionWorkspaceDirName("")).toMatch(/^sid_[0-9a-f]{64}$/);
    expect(sessionWorkspaceDir("")).toContain("sid_");
  });
});

describe("buildSandboxEnv 最小环境", () => {
  it("带必需系统变量+代理,不继承宿主业务变量或托管凭据", () => {
    process.env.SOME_HOST_SECRET = "leak-me";
    process.env.PLATFORM_API_SECRET = "t-1";
    const env = buildSandboxEnv();
    expect(env.PATH).toContain(process.env.PATH!); // 含宿主 PATH(前置了产品 bin 目录)
    expect(env.PLATFORM_API_SECRET).toBeUndefined();
    expect(env.SOME_HOST_SECRET).toBeUndefined();
    delete process.env.SOME_HOST_SECRET;
    delete process.env.PLATFORM_API_SECRET;
  });
  it("代理透传(lark-cli 是 Go net/http,认 HTTP(S)_PROXY、尊重 NO_PROXY、不读 ALL_PROXY;ALL_PROXY 仍透传兼容其它工具)", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:10809";
    process.env.ALL_PROXY = "http://127.0.0.1:10809";
    const env = buildSandboxEnv();
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:10809");
    expect(env.ALL_PROXY).toBe("http://127.0.0.1:10809");
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
  });
  it("设了代理时把飞书域名并入 NO_PROXY,QINGAGENT_SANDBOX_FEISHU_NO_PROXY=0 可关,无代理则不动", () => {
    // 测试机本身可能带宿主代理 env(WSL 翻墙代理),必须隔离:保存→清空→末尾恢复
    const KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
      "https_proxy", "http_proxy", "all_proxy", "no_proxy", "QINGAGENT_SANDBOX_FEISHU_NO_PROXY"];
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    const clearProxy = () => { for (const k of KEYS) delete process.env[k]; };
    try {
      // 有代理 + 默认:飞书域名并入 NO_PROXY(大小写同步),保留用户已有项
      clearProxy();
      process.env.HTTPS_PROXY = "http://127.0.0.1:10809";
      process.env.NO_PROXY = "localhost,127.0.0.1";
      const withProxy = buildSandboxEnv();
      expect(withProxy.NO_PROXY).toContain(".feishu.cn");
      expect(withProxy.NO_PROXY).toContain(".larksuite.com");
      expect(withProxy.NO_PROXY).toContain("localhost"); // 不覆盖用户原值
      expect(withProxy.no_proxy).toContain(".feishu.cn"); // 小写同步
      // 大小写两边都有不同用户项时,必须合并两边再同步,不能因 NO_PROXY 优先而丢 no_proxy。
      clearProxy();
      process.env.HTTPS_PROXY = "http://127.0.0.1:10809";
      process.env.NO_PROXY = ".corp.com";
      process.env.no_proxy = ".local";
      const withBothNoProxy = buildSandboxEnv();
      expect(withBothNoProxy.NO_PROXY).toContain(".corp.com");
      expect(withBothNoProxy.NO_PROXY).toContain(".local");
      expect(withBothNoProxy.no_proxy).toContain(".corp.com");
      expect(withBothNoProxy.no_proxy).toContain(".local");
      // 开关关闭:不并入飞书域名
      process.env.QINGAGENT_SANDBOX_FEISHU_NO_PROXY = "0";
      expect(buildSandboxEnv().NO_PROXY ?? "").not.toContain(".feishu.cn");
      // 无代理:整段逻辑跳过,不引入飞书域名
      clearProxy();
      expect(buildSandboxEnv().NO_PROXY ?? "").not.toContain(".feishu.cn");
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k]!;
      }
    }
  });
  it("PATH 前置产品级 CLI 目录(沙箱优先用产品自带 CLI)", async () => {
    const { SANDBOX_BIN_DIR } = await import("../workspace/sessionWorkspace.js");
    const env = buildSandboxEnv();
    expect(env.PATH!.startsWith(SANDBOX_BIN_DIR)).toBe(true);
  });
});

describe("sandboxExtraReadOnlyPaths", () => {
  afterEach(() => {
    delete process.env.QINGAGENT_SANDBOX_EXTRA_READONLY_PATHS;
  });

  it("按平台分隔符解析、trim、resolve、去重", () => {
    process.env.QINGAGENT_SANDBOX_EXTRA_READONLY_PATHS = [
      " /opt/Qingagent ",
      "/opt/Qingagent/resources",
      "/opt/Qingagent",
      "",
    ].join(process.platform === "win32" ? ";" : ":");

    expect(sandboxExtraReadOnlyPaths()).toEqual([
      "/opt/Qingagent",
      "/opt/Qingagent/resources",
    ]);
  });
});

describe("resolveIsolation", () => {
  beforeEach(() => __resetIsolationCacheForTest());
  afterEach(() => {
    delete process.env.QINGAGENT_SANDBOX_ISOLATION;
    __resetIsolationCacheForTest();
  });

  it("env 显式指定优先", () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    expect(resolveIsolation()).toBe("none");
  });
  it("自动探测返回三态之一且结果缓存", () => {
    const first = resolveIsolation();
    expect(["none", "seatbelt", "bwrap"]).toContain(first);
    expect(resolveIsolation()).toBe(first);
  });
});

describe("SANDBOX_TIMEOUT_MS env 解析", () => {
  afterEach(() => {
    delete process.env.QINGAGENT_SANDBOX_TIMEOUT_MS;
    vi.resetModules();
  });

  it("Round9 回归:负数或非法 timeout 降级默认正数", async () => {
    process.env.QINGAGENT_SANDBOX_TIMEOUT_MS = "-1";
    vi.resetModules();
    const negative = await import("../workspace/sessionWorkspace.js");
    expect(negative.SANDBOX_TIMEOUT_MS).toBe(120_000);

    process.env.QINGAGENT_SANDBOX_TIMEOUT_MS = "not-a-number";
    vi.resetModules();
    const invalid = await import("../workspace/sessionWorkspace.js");
    expect(invalid.SANDBOX_TIMEOUT_MS).toBe(120_000);
  });
});

describe("高危 env gate 真值口径", () => {
  afterEach(() => {
    delete process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS;
    delete process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS;
  });

  it("未设时默认关闭未隔离命令与凭据注入", () => {
    delete process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS;
    delete process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS;

    expect(allowUnisolatedCommands()).toBe(false);
    expect(shouldInjectCredentials()).toBe(false);
  });

  it("显式 =1 时开启未隔离命令与凭据注入", () => {
    process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS = "1";
    process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS = "1";

    expect(allowUnisolatedCommands()).toBe(true);
    expect(shouldInjectCredentials()).toBe(true);
  });

  it("显式 =0 时关闭未隔离命令与凭据注入", () => {
    process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS = "0";
    process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS = "0";

    expect(allowUnisolatedCommands()).toBe(false);
    expect(shouldInjectCredentials()).toBe(false);
  });
});

describe("getSessionWorkspace 默认安全 gate", () => {
  beforeEach(() => {
    __resetSessionWorkspaceCacheForTest();
    __resetIsolationCacheForTest();
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
  });

  afterEach(() => {
    delete process.env.QINGAGENT_SANDBOX_ISOLATION;
    delete process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS;
    __resetSessionWorkspaceCacheForTest();
    __resetIsolationCacheForTest();
  });

  it("未设 ALLOW_UNISOLATED_COMMANDS + none 隔离时不装 sandbox", async () => {
    delete process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS;
    const ws = await getSessionWorkspace("sess-default-noiso", { resolveSkillDirs: () => [] as string[] });

    expect(ws.sandbox).toBeFalsy();
    expect(ws.filesystem).toBeTruthy();
  });
});

describe("getSessionWorkspace 装配与缓存", () => {
  beforeEach(() => {
    __resetSessionWorkspaceCacheForTest();
    __resetIsolationCacheForTest();
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS = "1";
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
  });
  afterEach(() => {
    delete process.env.QINGAGENT_SANDBOX_ISOLATION;
    delete process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS;
    delete process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS;
    delete process.env.QINGAGENT_RUNTIME;
    delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
  });

  const opts = { resolveSkillDirs: () => [] as string[] };

  function folderSource(basePath: string, overrides: Partial<FolderSourceRecord> = {}): FolderSourceRecord {
    const now = "2026-01-01T00:00:00.000Z";
    return {
      id: "fld_test",
      sessionId: "sess-folder",
      provider: "desktop-local",
      name: "资料库",
      pathLabel: "/redacted",
      mountName: "source_test",
      mountPath: "/sources/source_test",
      readOnly: true,
      fileCount: 1,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: now,
      updatedAt: now,
      desktopRootPath: basePath,
      ...overrides,
    };
  }

  it("同会话复用同一实例,不同会话各自隔离", async () => {
    const a1 = await getSessionWorkspace("sess-a", opts);
    const a2 = await getSessionWorkspace("sess-a", opts);
    const b = await getSessionWorkspace("sess-b", opts);
    expect(a2).toBe(a1);
    expect(b).not.toBe(a1);
  });

  it("invalidateSessionWorkspace 删除缓存引用时会 destroy workspace", async () => {
    const ws = await getSessionWorkspace("sess-destroy", opts);
    const destroy = vi.spyOn(ws, "destroy").mockResolvedValue(undefined);

    invalidateSessionWorkspace("sess-destroy");

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("全量 invalidate 会 destroy 所有 cached workspace", async () => {
    const a = await getSessionWorkspace("sess-destroy-all-a", opts);
    const b = await getSessionWorkspace("sess-destroy-all-b", opts);
    const destroyA = vi.spyOn(a, "destroy").mockResolvedValue(undefined);
    const destroyB = vi.spyOn(b, "destroy").mockResolvedValue(undefined);

    invalidateSessionWorkspace();

    expect(destroyA).toHaveBeenCalledTimes(1);
    expect(destroyB).toHaveBeenCalledTimes(1);
  });

  it("全量 invalidate 也会等待活动租约释放", async () => {
    const lease = await acquireSessionWorkspace("sess-leased-invalidate-all", opts);
    const destroy = vi.spyOn(lease.workspace, "destroy").mockResolvedValue(undefined);

    invalidateSessionWorkspace();
    expect(destroy).not.toHaveBeenCalled();
    lease.release();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("活动租约仅延迟旧实例销毁，下轮重新装配 workspace 与挂载", async () => {
    const resolveFolderSources = vi.fn(() => [] as FolderSourceRecord[]);
    const leaseOpts = { ...opts, resolveFolderSources };
    const lease = await acquireSessionWorkspace("sess-leased-invalidate", leaseOpts);
    const releaseBackground = lease.retain();
    const destroy = vi.spyOn(lease.workspace, "destroy").mockResolvedValue(undefined);

    invalidateSessionWorkspace("sess-leased-invalidate");
    expect(destroy).not.toHaveBeenCalled();
    expect(__sessionWorkspaceCacheStatsForTest()).toMatchObject({
      cacheSize: 0,
      leaseCount: 2,
      pendingDestroyCount: 1,
    });

    const nextTurn = await acquireSessionWorkspace("sess-leased-invalidate", leaseOpts);
    expect(nextTurn.workspace).not.toBe(lease.workspace);
    expect(nextTurn.workspace.sandbox).not.toBe(lease.workspace.sandbox);
    expect(resolveFolderSources).toHaveBeenCalledTimes(2);
    expect(__sessionWorkspaceCacheStatsForTest()).toMatchObject({
      cacheSize: 1,
      pendingDestroyCount: 1,
    });
    lease.release();
    nextTurn.release();
    expect(destroy).not.toHaveBeenCalled();

    releaseBackground();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(__sessionWorkspaceCacheStatsForTest()).toMatchObject({
      leaseCount: 0,
      pendingDestroyCount: 0,
    });
  });

  it("租约 Promise 落账前的同步预留也会阻止失效销毁", async () => {
    const workspace = await getSessionWorkspace("sess-lease-reservation", opts);
    const destroy = vi.spyOn(workspace, "destroy").mockResolvedValue(undefined);

    const acquiring = acquireSessionWorkspace("sess-lease-reservation", opts);
    invalidateSessionWorkspace("sess-lease-reservation");
    expect(destroy).not.toHaveBeenCalled();
    expect(__sessionWorkspaceCacheStatsForTest().pendingAcquireCount).toBe(1);

    const lease = await acquiring;
    expect(lease.workspace).toBe(workspace);
    expect(destroy).not.toHaveBeenCalled();
    lease.release();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("LRU 只标记仍有租约的 Workspace，释放后才销毁", async () => {
    const lease = await acquireSessionWorkspace("sess-leased-lru-oldest", opts);
    const destroy = vi.spyOn(lease.workspace, "destroy").mockResolvedValue(undefined);

    for (let index = 0; index < 512; index += 1) {
      await getSessionWorkspace(`sess-leased-lru-${index}`, opts);
    }

    expect(destroy).not.toHaveBeenCalled();
    expect(__sessionWorkspaceCacheStatsForTest().pendingDestroyCount).toBe(1);
    lease.release();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("Round9 回归:同会话并发首建只产出一个实例(inflight 去重,防游离实例泄漏)", async () => {
    // BUG-1:cache miss 与 cache.set 之间有异步资料源解析让出事件循环，
    // 并发多路会各建一个 Workspace。这里用一个真异步的 resolveFolderSources 放大竞态窗口，
    // 断言 8 路并发拿到的是同一个实例。
    __resetSessionWorkspaceCacheForTest();
    const slowOpts = {
      ...opts,
      resolveFolderSources: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return [];
      },
    };
    const all = await Promise.all(
      Array.from({ length: 8 }, () => getSessionWorkspace("sess-concurrent", slowOpts)),
    );
    const unique = new Set(all);
    expect(unique.size).toBe(1);
    expect(all[0]).toBe(await getSessionWorkspace("sess-concurrent", slowOpts));
  });

  it("装配出的 Workspace 带 sandbox 与组合文件系统", async () => {
    const ws = await getSessionWorkspace("sess-c", opts);
    expect(ws.sandbox).toBeTruthy();
    expect(ws.filesystem).toBeTruthy();
    expect(ws.filesystem?.provider).toBe("composite");
  });

  it("none 隔离 + 禁未隔离命令时:不装 sandbox(不暴露命令执行),仍有文件系统", async () => {
    process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS = "0";
    __resetSessionWorkspaceCacheForTest();
    const ws = await getSessionWorkspace("sess-noiso", opts);
    expect(ws.sandbox).toBeFalsy();
    expect(ws.filesystem).toBeTruthy();
    delete process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS;
  });

  it("cleanupSessionWorkspace 删除会话沙箱目录(连同模型写的文件)", async () => {
    const dir = sessionWorkspaceDir("sess-cleanup");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "artifact.txt"), "模型写的产物");
    expect(existsSync(dir)).toBe(true);
    await cleanupSessionWorkspace("sess-cleanup");
    expect(existsSync(dir)).toBe(false);
  });

  it("cleanupSessionWorkspace 与 reset 会清理 generation key，避免长跑保留", async () => {
    const cleanupKey = sessionWorkspaceDirName("sess-generation-cleanup");
    invalidateSessionWorkspace("sess-generation-cleanup");
    expect(__sessionWorkspaceCacheStatsForTest().generationKeys).not.toContain(cleanupKey);

    const dir = sessionWorkspaceDir("sess-generation-cleanup");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "artifact.txt"), "cleanup generation probe");
    await cleanupSessionWorkspace("sess-generation-cleanup");
    expect(__sessionWorkspaceCacheStatsForTest().generationKeys).not.toContain(cleanupKey);

    const resetKey = sessionWorkspaceDirName("sess-generation-reset");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = getSessionWorkspace("sess-generation-reset", {
      ...opts,
      resolveFolderSources: async () => {
        await gate;
        return [];
      },
    });
    await Promise.resolve();
    invalidateSessionWorkspace("sess-generation-reset");
    expect(__sessionWorkspaceCacheStatsForTest().generationKeys).toContain(resetKey);
    __resetSessionWorkspaceCacheForTest();
    expect(__sessionWorkspaceCacheStatsForTest().generationSize).toBe(0);
    expect(__sessionWorkspaceCacheStatsForTest().activeBuildSize).toBe(0);
    // 释放被 reset 摘除的旧构建，避免测试留下永不 settle 的异步句柄。
    release();
    await pending;
    __resetSessionWorkspaceCacheForTest();
  });

  // BUG-A1 回归:会话 Workspace 的技能发现源若沿用 CompositeFilesystem,
  // resolveSkillDirs 返回的宿主绝对路径匹配不到 /workspace、/skills 挂载,
  // skills.list() 恒为空——doc-calc/feishu 等内置技能全失效。修复后显式传
  // LocalSkillSource,绝对路径按宿主 fs 解析,技能可被发现。
  it("技能发现:resolveSkillDirs 的绝对路径能被 skills.list() 找到", async () => {
    const skillRoot = mkdtempSync(join(tmpdir(), "sbx-skill-"));
    const skillDir = join(skillRoot, "doc-calc-probe");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: doc-calc-probe\ndescription: 探针技能\n---\n\n正文。\n",
    );
    __resetSessionWorkspaceCacheForTest();
    const ws = await getSessionWorkspace("sess-skill", {
      ...opts,
      resolveSkillDirs: () => [skillDir],
    });
    const list = (await ws.skills?.list()) ?? [];
    expect(list.map((s) => s.name)).toContain("doc-calc-probe");
  });

  it("/workspace list_files 不泄露 symlinkTarget 宿主真实路径", async () => {
    const sessionId = "sess-workspace-symlink-redact";
    const sessionDir = sessionWorkspaceDir(sessionId);
    const root = mkdtempSync(join(tmpdir(), "workspace-symlink-redact-"));
    const sourceDir = join(root, "source-root");
    const outsideDir = join(root, "outside-root");
    rmSync(sessionDir, { recursive: true, force: true });
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(sourceDir, "secret.md"), "ROUND17_SOURCE_SECRET");
    writeFileSync(join(outsideDir, "host-secret.txt"), "ROUND17_HOST_SECRET");
    symlinkSync(sourceDir, join(sessionDir, "link-to-source-dir"), "dir");
    symlinkSync(join(outsideDir, "host-secret.txt"), join(sessionDir, "link-to-host-secret.txt"));

    const ws = await getSessionWorkspace(sessionId, opts);
    const entries = await ws.filesystem!.readdir("/workspace");
    const serializedEntries = JSON.stringify(entries);
    expect(serializedEntries).toContain("link-to-source-dir");
    expect(serializedEntries).toContain("isSymlink");
    expect(serializedEntries).not.toContain(sourceDir);
    expect(serializedEntries).not.toContain(outsideDir);
    expect(serializedEntries).not.toContain("symlinkTarget");

    const tools = await createWorkspaceTools(ws, { workspace: ws });
    const listOutput = await tools[WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]?.execute?.(
      { path: "/workspace", maxDepth: 2, respectGitignore: false },
      { workspace: ws } as never,
    );
    expect(String(listOutput)).toContain("link-to-source-dir");
    expect(String(listOutput)).toContain("link-to-host-secret.txt");
    expect(String(listOutput)).not.toContain(sourceDir);
    expect(String(listOutput)).not.toContain(outsideDir);
    expect(String(listOutput)).not.toContain("ROUND17_SOURCE_SECRET");
    expect(String(listOutput)).not.toContain("ROUND17_HOST_SECRET");
  });

  it("本地文件夹资料库以 /sources 下嵌套 CompositeFilesystem 挂载且只读", async () => {
    const root = mkdtempSync(join(tmpdir(), "folder-source-"));
    const sourceDir = join(root, "library");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "a.md"), "资料库正文");

    const ws = await getSessionWorkspace("sess-folder", {
      ...opts,
      resolveFolderSources: () => [folderSource(sourceDir)],
    });
    await ws.init();

    const fs = ws.filesystem!;
    const rootEntries = await fs.readdir("/sources");
    expect(rootEntries.map((entry) => entry.name)).toContain("source_test");
    const sourceEntries = await fs.readdir("/sources/source_test");
    expect(sourceEntries.map((entry) => entry.name)).toContain("a.md");
    await expect(
      fs.readFile("/sources/source_test/a.md", { encoding: "utf8" }),
    ).resolves.toBe("资料库正文");
    await expect(
      fs.writeFile("/sources/source_test/new.md", "nope"),
    ).rejects.toThrow();
    await expect(
      fs.writeFile("/workspace/ok.txt", "workspace 可写", { recursive: true }),
    ).resolves.toBeUndefined();
    await expect(
      fs.copyFile("/sources/source_test/a.md", "/workspace/copied-from-source.md", { overwrite: true }),
    ).rejects.toThrow("copyFile from /sources is not allowed");
    await expect(
      fs.exists("/workspace/copied-from-source.md"),
    ).resolves.toBe(false);
    await ws.destroy();
  });

  it("Round9 回归:无 desktop-local flag 时不挂载已传入的本地资料库", async () => {
    delete process.env.QINGAGENT_RUNTIME;
    delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
    __resetSessionWorkspaceCacheForTest();
    const root = mkdtempSync(join(tmpdir(), "folder-source-no-flag-"));
    const sourceDir = join(root, "library");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "secret.md"), "ROUND9_VPS_SECRET");

    const ws = await getSessionWorkspace("sess-folder-no-flag", {
      ...opts,
      resolveFolderSources: () => [folderSource(sourceDir)],
    });
    await ws.init();

    await expect(ws.filesystem!.readdir("/sources")).rejects.toThrow();
    await expect(ws.filesystem!.readFile("/sources/source_test/secret.md", { encoding: "utf8" })).rejects.toThrow();
    await ws.destroy();
  });

  it("资料库 source 损坏时跳过坏挂载而不拖垮 Workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "folder-source-invalid-"));
    const sourceDir = join(root, "library");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "ok.md"), "ok");
    const valid = folderSource(sourceDir, {
      id: "fld_valid",
      mountName: "source_valid",
      mountPath: "/sources/source_valid",
    });
    const invalid = folderSource(sourceDir, {
      id: "fld_invalid",
      mountName: "source_invalid",
      mountPath: "/sources/source_invalid",
      desktopRootPath: undefined,
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ws = await getSessionWorkspace("sess-folder-invalid", {
      ...opts,
      resolveFolderSources: () => [valid, invalid],
    });
    await ws.init();

    await expect(ws.filesystem!.readFile("/sources/source_valid/ok.md", { encoding: "utf8" })).resolves.toBe("ok");
    await expect(ws.filesystem!.readdir("/sources/source_invalid")).rejects.toThrow();
    expect(warn).toHaveBeenCalled();
    await ws.destroy();
  });

  it("invalidateSessionWorkspace 销毁失配代实例，并让旧调用方拿到当前代 workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "folder-source-race-"));
    const sourceDir = join(root, "library");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "race.md"), "race");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finishDestroy: () => void = () => undefined;
    const destroyGate = new Promise<void>((resolve) => {
      finishDestroy = resolve;
    });
    const destroy = vi.spyOn(Workspace.prototype, "destroy").mockImplementation(() => destroyGate);
    try {
      const first = getSessionWorkspace("sess-race", {
        ...opts,
        resolveFolderSources: async () => {
          await gate;
          return [];
        },
      });
      await Promise.resolve();

      invalidateSessionWorkspace("sess-race");
      const second = getSessionWorkspace("sess-race", {
        ...opts,
        resolveFolderSources: () => [folderSource(sourceDir, { id: "fld_race", mountName: "source_race", mountPath: "/sources/source_race" })],
      });
      release();

      const currentWs = await second;
      await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
      let firstSettled = false;
      void first.then(() => {
        firstSettled = true;
      });
      await Promise.resolve();
      expect(firstSettled).toBe(false);
      finishDestroy();
      const firstResult = await first;
      expect(firstResult).toBe(currentWs);
      const entries = await currentWs.filesystem!.readdir("/sources/source_race");
      expect(entries.map((entry) => entry.name)).toContain("race.md");

      const cached = await getSessionWorkspace("sess-race", {
        ...opts,
        resolveFolderSources: () => [folderSource(sourceDir, { id: "fld_race", mountName: "source_race", mountPath: "/sources/source_race" })],
      });
      expect(cached).toBe(currentWs);
      await expect(cached.filesystem!.readdir("/sources/source_race")).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "race.md" })]),
      );
    } finally {
      finishDestroy();
      destroy.mockRestore();
    }
  });

  it("LRU 驱逐 cached workspace 时同步修剪 generation key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessionId = "sess-generation-lru";
    const key = sessionWorkspaceDirName(sessionId);
    const first = getSessionWorkspace(sessionId, {
      ...opts,
      resolveFolderSources: async () => {
        await gate;
        return [];
      },
    });
    await Promise.resolve();
    invalidateSessionWorkspace(sessionId);
    const second = getSessionWorkspace(sessionId, opts);
    release();
    await Promise.all([first, second]);
    expect(__sessionWorkspaceCacheStatsForTest().generationKeys).toContain(key);

    for (let index = 0; index < 520; index += 1) {
      await getSessionWorkspace(`sess-generation-lru-evict-${index}`, opts);
    }

    expect(__sessionWorkspaceCacheStatsForTest().generationKeys).not.toContain(key);
  });

  it("资料库 metadata、readdir 与错误信息不泄露桌面真实路径", async () => {
    const root = mkdtempSync(join(tmpdir(), "folder-source-redact-"));
    const sourceDir = join(root, "library");
    const outsideDir = join(root, "outside");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(sourceDir, "inside.md"), "资料库正文");
    writeFileSync(join(outsideDir, "secret.md"), "secret");
    symlinkSync("inside.md", join(sourceDir, "link-in.md"));
    symlinkSync(join(outsideDir, "secret.md"), join(sourceDir, "link-out.md"));

    const source = folderSource(sourceDir);
    const ws = await getSessionWorkspace("sess-redact", {
      ...opts,
      resolveFolderSources: () => [source],
    });
    await ws.init();

    const infoText = JSON.stringify(await ws.getInfo());
    expect(infoText).not.toContain(sourceDir);
    expect(infoText).toContain(source.mountPath);

    const entries = await ws.filesystem!.readdir("/sources/source_test");
    expect(entries.map((entry) => entry.name)).toContain("link-in.md");
    expect(entries.map((entry) => entry.name)).not.toContain("link-out.md");
    expect(JSON.stringify(entries)).not.toContain(sourceDir);
    expect(JSON.stringify(entries)).not.toContain(outsideDir);

    try {
      await ws.filesystem!.stat("/sources/source_test/link-out.md");
      throw new Error("expected external symlink stat to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(sourceDir);
      expect(message).not.toContain(outsideDir);
      expect(message).toContain(source.mountPath);
    }
  });
});
