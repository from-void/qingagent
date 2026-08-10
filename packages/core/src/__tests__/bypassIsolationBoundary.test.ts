// 「以后不用再问我」全局开关的**边界验证**。
//
// 这套用例回答四个问题,任何一条不成立都必须先修实现再谈别的:
// ① 显式关闭时仍按平台隔离装配,seatbelt/bwrap 照旧生效;
// ② 开启后变成无隔离,且已有会话立即换形态(不是"下次新会话才生效");
// ③ 关闭后立即回到隔离;
// ④ 两种状态下都不会扩大到整个系统钥匙串 / 浏览器数据 / 整个 HOME。
//
// 与 securityBypass.test.ts 分工:那边锁"确认卡与提示词形态",这里锁"隔离与读墙边界"。

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invalidateSessionWorkspaceSpy = vi.fn();

vi.mock("../workspace/sessionWorkspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/sessionWorkspace.js")>();
  return { ...actual, invalidateSessionWorkspace: invalidateSessionWorkspaceSpy };
});

const setBypassModeSpy = vi.fn();

vi.mock("../security/bypassMode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/bypassMode.js")>();
  return {
    ...actual,
    // 不打 DB:写入语义由 bypassMode 自己的用例覆盖,这里只验证"写完立刻让会话换形态"。
    setBypassMode: (enabled: boolean) => {
      setBypassModeSpy(enabled);
      actual.__setBypassModeCacheForTest(enabled);
      return Promise.resolve({ enabled, enabledAt: enabled ? new Date(0).toISOString() : null });
    },
  };
});

const {
  __resetBypassModeForTest,
  __setBypassModeCacheForTest,
  isBypassEnabled,
} = await import("../security/bypassMode.js");
const { applyBypassMode } = await import("../security/bypassModeControl.js");
const {
  __resetIsolationCacheForTest,
  resolveCredentialWallMode,
  resolveEffectiveIsolation,
  resolveIsolation,
} = await import("../workspace/sessionWorkspace.js");
const { resolveReadWallPolicy } = await import("../workspace/readWallPolicy.js");
type ResolveReadWallPolicyOptions =
  import("../workspace/readWallPolicy.js").ResolveReadWallPolicyOptions;

const roots: string[] = [];

async function readWallFixture(
  platform: "linux" | "darwin",
): Promise<ResolveReadWallPolicyOptions> {
  const root = await mkdtemp(join(tmpdir(), "qingagent-bypass-boundary-"));
  roots.push(root);
  const home = join(root, "home");
  const dataDir = join(home, "app-data");
  const sessionDir = join(dataDir, "sessions", "current");
  const sandboxBinDir = join(dataDir, "bin");
  const builtinSkillsDir = join(home, "product", "skills");
  const userSkillsDir = join(home, ".qingagent", "skills");
  await Promise.all([
    mkdir(sessionDir, { recursive: true }),
    mkdir(sandboxBinDir, { recursive: true }),
    mkdir(builtinSkillsDir, { recursive: true }),
    mkdir(userSkillsDir, { recursive: true }),
    mkdir(join(home, ".ssh"), { recursive: true }),
    mkdir(join(home, ".local", "share", "keyrings"), { recursive: true }),
    mkdir(join(home, ".config", "google-chrome"), { recursive: true }),
    mkdir(join(home, "Library", "Keychains"), { recursive: true }),
    mkdir(join(home, "Library", "Application Support", "Google", "Chrome"), { recursive: true }),
  ]);
  return {
    platform,
    env: { HOME: home },
    dataDir,
    sessionDir,
    sandboxBinDir,
    builtinSkillsDir,
    userSkillsDir,
    extraReadOnlyPaths: [],
    effectiveUid: typeof process.geteuid === "function" ? process.geteuid() : -1,
    effectiveHome: home,
  };
}

beforeEach(() => {
  invalidateSessionWorkspaceSpy.mockClear();
  setBypassModeSpy.mockClear();
  __resetBypassModeForTest();
  // 本文件专测隔离边界,显式固定在「每次询问」后再切换。
  __setBypassModeCacheForTest(false);
  __resetIsolationCacheForTest();
  process.env.QINGAGENT_SANDBOX_ISOLATION = "bwrap";
});

afterEach(async () => {
  __resetBypassModeForTest();
  __resetIsolationCacheForTest();
  delete process.env.QINGAGENT_SANDBOX_ISOLATION;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bypass 边界①②③:隔离形态切换", () => {
  it("显式关闭时仍为平台隔离,读墙按标准档", () => {
    expect(isBypassEnabled()).toBe(false);
    expect(resolveEffectiveIsolation()).toBe(resolveIsolation());
    expect(resolveEffectiveIsolation()).toBe("bwrap");
    expect(resolveCredentialWallMode()).toBe("standard");
  });

  it("开启后变为 none,并让已有会话立即换形态", async () => {
    await applyBypassMode(true);

    expect(setBypassModeSpy).toHaveBeenCalledWith(true);
    expect(isBypassEnabled()).toBe(true);
    expect(resolveEffectiveIsolation()).toBe("none");
    // 已有会话工作区被就地失效 = 下一条命令立刻换形态,而不是等新会话。
    expect(invalidateSessionWorkspaceSpy).toHaveBeenCalledTimes(1);
    // 平台探测本身不受影响,只是本次装配不用它。
    expect(resolveIsolation()).toBe("bwrap");
  });

  it("关闭后立即恢复隔离,并同样让已有会话立即换回", async () => {
    await applyBypassMode(true);
    invalidateSessionWorkspaceSpy.mockClear();

    await applyBypassMode(false);

    expect(isBypassEnabled()).toBe(false);
    expect(resolveEffectiveIsolation()).toBe("bwrap");
    expect(resolveCredentialWallMode()).toBe("standard");
    expect(invalidateSessionWorkspaceSpy).toHaveBeenCalledTimes(1);
  });
});

describe("bypass 边界④:两种状态都不得扩大到钥匙串 / 浏览器数据 / 整个 HOME", () => {
  it.each([
    { label: "关闭", enabled: false, expectedMode: "standard" as const },
    { label: "开启", enabled: true, expectedMode: "wide" as const },
  ])("linux · $label:keyring 与浏览器数据始终 deny,HOME 不进 allow", async ({ enabled, expectedMode }) => {
    const options = await readWallFixture("linux");
    const home = options.effectiveHome!;
    if (enabled) await applyBypassMode(true);
    expect(resolveCredentialWallMode()).toBe(expectedMode);

    const policy = await resolveReadWallPolicy({
      ...options,
      credentialWallMode: resolveCredentialWallMode(),
    });
    const denies = policy.credentialDenyPaths.map((path) => path.lexicalPath);
    expect(denies).toContain(join(home, ".local", "share", "keyrings"));
    expect(denies).toContain(join(home, ".config", "google-chrome"));
    // 整个 HOME 永远不是放行项:最宽档放开的只是"可写",不是"把 HOME 挂成 allow 绕过 deny"。
    expect(policy.allowPaths.map((path) => path.lexicalPath)).not.toContain(home);
  });

  it.each([
    { label: "关闭", enabled: false },
    { label: "开启", enabled: true },
  ])("darwin · $label:系统钥匙串与浏览器数据始终 deny", async ({ enabled }) => {
    const options = await readWallFixture("darwin");
    const home = options.effectiveHome!;
    if (enabled) await applyBypassMode(true);

    const policy = await resolveReadWallPolicy({
      ...options,
      credentialWallMode: resolveCredentialWallMode(),
    });
    const denies = policy.credentialDenyPaths.map((path) => path.lexicalPath);
    expect(denies).toContain(join(home, "Library", "Keychains"));
    expect(denies).toContain("/Library/Keychains");
    expect(denies).toContain(join(home, "Library", "Application Support", "Google", "Chrome"));
    expect(policy.allowPaths.map((path) => path.lexicalPath)).not.toContain(home);
  });
});
