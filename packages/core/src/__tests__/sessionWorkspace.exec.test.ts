import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  __resetIsolationCacheForTest,
  __resetSessionWorkspaceCacheForTest,
  getSessionWorkspace,
  sessionWorkspaceDir,
} from "../workspace/sessionWorkspace.js";

// 沙箱 P0 冒烟:真实执行命令(isolation=none 直跑)。
// 这是"沙箱跑通"的最小存活证明:写文件→读输出→退出码透传。

describe("会话沙箱真实命令执行", () => {
  beforeEach(() => {
    __resetSessionWorkspaceCacheForTest();
    __resetIsolationCacheForTest();
    process.env.QINGAGENT_SANDBOX_ISOLATION = "none";
    process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS = "1";
  });
  afterEach(async () => {
    delete process.env.QINGAGENT_SANDBOX_ISOLATION;
    delete process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS;
    await rm(sessionWorkspaceDir("exec-smoke"), { recursive: true, force: true });
  });

  it("echo/计算/工作目录写读全链可用", async () => {
    const ws = await getSessionWorkspace("exec-smoke", { resolveSkillDirs: () => [] });
    await ws.init?.();
    const sandbox = ws.sandbox!;
    const exec = sandbox.executeCommand!.bind(sandbox);

    // 1) 基础执行与 stdout 捕获
    const echo = await exec("printf sbx-ok");
    expect(echo.exitCode).toBe(0);
    expect(echo.stdout).toContain("sbx-ok");

    // 2) 数学计算场景(表格总计类):shell 算 1..100 求和
    const calc = await exec("sh -c 's=0; i=1; while [ $i -le 100 ]; do s=$((s+i)); i=$((i+1)); done; printf total=$s'");
    expect(calc.stdout).toContain("total=5050");

    // 3) 工作目录隔离:写文件→另一条命令读回(确认 cwd 是会话目录)
    const write = await exec("printf '{\"rows\":[1,2,3]}' > data.json");
    expect(write.exitCode).toBe(0);
    const read = await exec("cat data.json");
    expect(read.stdout).toContain("\"rows\":[1,2,3]");

    // 4) 退出码如实透传
    const fail = await exec("sh -c 'exit 3'");
    expect(fail.exitCode).toBe(3);
  }, 30_000);

  it("env 最小化:沙箱内看不到宿主任意变量", async () => {
    process.env.HOST_ONLY_SECRET = "must-not-leak";
    const ws = await getSessionWorkspace("exec-smoke", { resolveSkillDirs: () => [] });
    await ws.init?.();
    const probe = await ws.sandbox!.executeCommand!("sh -c 'printf leak=${HOST_ONLY_SECRET:-none}'");
    expect(probe.stdout).toContain("leak=none");
    delete process.env.HOST_ONLY_SECRET;
  }, 30_000);
});
