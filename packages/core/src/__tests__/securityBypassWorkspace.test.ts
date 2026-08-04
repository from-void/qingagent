// 「以后不用再问我」端到端形态回归:落库 → 会话工作区换形态 → 关掉后完全回退。
//
// 这里走真实的 setBypassMode/applyBypassMode(只把 app_settings 换成内存替身),
// 目的就是锁住"开关真的驱动隔离与命令暴露",而不是只测一个布尔值。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  prepareReadWall: vi.fn(async (_options: unknown) => ({
    nativeSandbox: { allowNetwork: true, readOnlyPaths: [], readWritePaths: [], bwrapArgs: [] },
    effectiveHome: "/home/tester",
    policyHash: "hash",
    ruleCount: 1,
    warnings: [],
    mode: "bwrap-read-wall" as const,
    credentialPaths: [],
    credentialWallMode: "standard" as const,
    verifyIntegrity: async () => undefined,
  })),
}));

vi.mock("@qingagent/db", () => ({
  resolveDbUrl: () => "file::memory:",
  listCredentialGrants: vi.fn(async () => []),
  getAppSetting: vi.fn(async (key: string) => mocks.settings.get(key) ?? null),
  setAppSetting: vi.fn(async (key: string, value: string) => {
    mocks.settings.set(key, value);
  }),
}));

vi.mock("../skills/credentialRequests.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skills/credentialRequests.js")>();
  return {
    ...actual,
    listCredentialRequests: vi.fn(async () => []),
    ensureCredentialPathExists: vi.fn(async () => undefined),
  };
});

vi.mock("../workspace/readWallSandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/readWallSandbox.js")>();
  return { ...actual, prepareReadWall: mocks.prepareReadWall };
});

import { __resetBypassModeForTest, loadBypassMode } from "../security/bypassMode.js";
import { applyBypassMode } from "../security/bypassModeControl.js";
import {
  __resetIsolationCacheForTest,
  __resetSessionWorkspaceCacheForTest,
  getSessionWorkspace,
} from "../workspace/sessionWorkspace.js";

const opts = { resolveSkillDirs: () => [] as string[] };
const SESSION = "sess-bypass-assembly";

describe("全局免询问开关驱动会话工作区形态", () => {
  beforeEach(() => {
    mocks.settings.clear();
    mocks.prepareReadWall.mockClear();
    __resetBypassModeForTest();
    __resetSessionWorkspaceCacheForTest();
    __resetIsolationCacheForTest();
    // 平台探测钉死在 none:本用例只考察开关本身,不受宿主是否装了 bwrap 影响。
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    delete process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS;
  });

  afterEach(() => {
    mocks.settings.clear();
    __resetBypassModeForTest();
    __resetSessionWorkspaceCacheForTest();
    __resetIsolationCacheForTest();
    delete process.env.QINGAGENT_SANDBOX_ISOLATION;
    delete process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS;
  });

  it("默认形态不暴露命令执行;勾选后无隔离且可执行;关掉后完全回退", async () => {
    const before = await getSessionWorkspace(SESSION, opts);
    expect(before.sandbox).toBeFalsy();
    expect(before.filesystem).toBeTruthy();

    // applyBypassMode 自带失效:已有会话下一次取用就是新形态,不需要额外手动清缓存。
    await applyBypassMode(true);
    const during = await getSessionWorkspace(SESSION, opts);
    expect(during).not.toBe(before);
    expect(during.sandbox).toBeTruthy();
    expect((during.sandbox as { isolation?: string } | undefined)?.isolation ?? "none")
      .toBe("none");

    await applyBypassMode(false);
    const after = await getSessionWorkspace(SESSION, opts);
    expect(after.sandbox).toBeFalsy();
  }, 30_000);

  it("有真隔离的机器上:默认形态命令进隔离,勾选后才不隔离,关掉又回隔离", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "bwrap";
    __resetIsolationCacheForTest();
    const session = "sess-bypass-isolated";

    // 默认形态:走完整读墙预检(命令进隔离),凭证墙按标准档。
    await getSessionWorkspace(session, opts);
    expect(mocks.prepareReadWall).toHaveBeenCalledTimes(1);
    expect(mocks.prepareReadWall.mock.calls[0]?.[0]).toMatchObject({
      platform: "linux",
      credentialWallMode: "standard",
    });

    // 勾选后:不再装隔离,连读墙都不用准备,命令直接以用户身份跑。
    await applyBypassMode(true);
    const unisolated = await getSessionWorkspace(session, opts);
    expect(mocks.prepareReadWall).toHaveBeenCalledTimes(1);
    expect(unisolated.sandbox).toBeTruthy();
    expect((unisolated.sandbox as { isolation?: string }).isolation).toBe("none");

    // 关掉后:隔离与读墙原样回来。
    await applyBypassMode(false);
    await getSessionWorkspace(session, opts);
    expect(mocks.prepareReadWall).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("状态是持久的:进程内缓存清掉后重新加载仍是开启", async () => {
    await applyBypassMode(true);
    __resetBypassModeForTest();

    expect((await loadBypassMode()).enabled).toBe(true);

    await applyBypassMode(false);
    __resetBypassModeForTest();
    expect((await loadBypassMode()).enabled).toBe(false);
  });
});
