// 「以后不用再问我」端到端形态回归:落库 → 会话工作区换形态 → 关掉后完全回退。
//
// 这里走真实的 setBypassMode/applyBypassMode(只把 app_settings 换成内存替身),
// 目的就是锁住"开关真的驱动隔离与命令暴露",而不是只测一个布尔值。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppSetting } from "@qingagent/db";

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

import {
  __resetBypassModeForTest,
  loadBypassMode,
  SETTING_SECURITY_BYPASS,
} from "../security/bypassMode.js";
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

  it("新默认无隔离且可执行;显式改为每次询问后回退;再开启可即时恢复", async () => {
    const defaultWorkspace = await getSessionWorkspace(SESSION, opts);
    expect(defaultWorkspace.sandbox).toBeTruthy();
    expect((defaultWorkspace.sandbox as { isolation?: string }).isolation).toBe("none");

    // applyBypassMode 自带失效:已有会话下一次取用就是新形态,不需要额外手动清缓存。
    await applyBypassMode(false);
    const askWorkspace = await getSessionWorkspace(SESSION, opts);
    expect(askWorkspace).not.toBe(defaultWorkspace);
    expect(askWorkspace.sandbox).toBeFalsy();
    expect(askWorkspace.filesystem).toBeTruthy();

    await applyBypassMode(true);
    const enabledAgain = await getSessionWorkspace(SESSION, opts);
    expect(enabledAgain).not.toBe(askWorkspace);
    expect(enabledAgain.sandbox).toBeTruthy();
    expect((enabledAgain.sandbox as { isolation?: string }).isolation).toBe("none");
  }, 30_000);

  it("有真隔离的机器上:新默认不隔离,显式每次询问后进隔离,切换即时生效", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "bwrap";
    __resetIsolationCacheForTest();
    const session = "sess-bypass-isolated";

    // 新默认:不装隔离,连读墙都不用准备。
    const initial = await getSessionWorkspace(session, opts);
    expect(mocks.prepareReadWall).not.toHaveBeenCalled();
    expect((initial.sandbox as { isolation?: string }).isolation).toBe("none");

    // 用户显式改为每次询问:走完整读墙预检,凭证墙按标准档。
    await applyBypassMode(false);
    await getSessionWorkspace(session, opts);
    expect(mocks.prepareReadWall).toHaveBeenCalledTimes(1);
    expect(mocks.prepareReadWall.mock.calls[0]?.[0]).toMatchObject({
      platform: "linux",
      credentialWallMode: "standard",
    });

    // 再开启:不再装隔离,命令直接以用户身份跑。
    await applyBypassMode(true);
    const unisolated = await getSessionWorkspace(session, opts);
    expect(mocks.prepareReadWall).toHaveBeenCalledTimes(1);
    expect(unisolated.sandbox).toBeTruthy();
    expect((unisolated.sandbox as { isolation?: string }).isolation).toBe("none");

    // 再关掉后:隔离与读墙原样回来。
    await applyBypassMode(false);
    await getSessionWorkspace(session, opts);
    expect(mocks.prepareReadWall).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("app_settings 缺 key 时按新默认加载为 enabled:true 且无开启时间", async () => {
    expect(await loadBypassMode()).toEqual({ enabled: true, enabledAt: null });
  });

  it("首次读取失败且无已知值时按新默认开启", async () => {
    vi.mocked(getAppSetting).mockRejectedValueOnce(new Error("read failed"));
    expect(await loadBypassMode()).toEqual({ enabled: true, enabledAt: null });
  });

  it("已有显式 false 时读取失败仍尊重每次询问档", async () => {
    await applyBypassMode(false);
    vi.mocked(getAppSetting).mockRejectedValueOnce(new Error("read failed"));
    expect(await loadBypassMode()).toEqual({ enabled: false, enabledAt: null });
  });

  it.each([
    ["坏 JSON", "not-json"],
    ["数组", "[]"],
    ["缺 enabled", JSON.stringify({ enabledAt: "2026-08-11T00:00:00.000Z" })],
    ["enabled 类型非法", JSON.stringify({ enabled: "false" })],
  ])("app_settings 值非法(%s)时按新默认开启", async (_label, raw) => {
    mocks.settings.set(SETTING_SECURITY_BYPASS, raw);
    expect(await loadBypassMode()).toEqual({ enabled: true, enabledAt: null });
  });

  it("状态是持久的:显式 true/false 在进程内缓存清掉后仍按落盘值恢复", async () => {
    await applyBypassMode(true);
    __resetBypassModeForTest();

    expect((await loadBypassMode()).enabled).toBe(true);

    await applyBypassMode(false);
    __resetBypassModeForTest();
    expect((await loadBypassMode()).enabled).toBe(false);
  });
});
