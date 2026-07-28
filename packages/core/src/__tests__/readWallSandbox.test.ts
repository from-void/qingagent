import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetIsolationCacheForTest,
  __resetSessionWorkspaceCacheForTest,
  getSessionWorkspace,
  sessionWorkspaceDir,
} from "../workspace/sessionWorkspace.js";
import { ReadWallLocalSandbox } from "../workspace/readWallSandbox.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.QINGAGENT_SANDBOX_ISOLATION;
  delete process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS;
  __resetIsolationCacheForTest();
  __resetSessionWorkspaceCacheForTest();
  await rm(sessionWorkspaceDir("read-wall-fail-closed"), { recursive: true, force: true });
  await rm(sessionWorkspaceDir("read-wall-seatbelt-fail-closed"), { recursive: true, force: true });
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("read-wall fail-closed 与 mount 升级锁", () => {
  it("后台 spawn 与前台命令共享完整性复核和熔断", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-read-wall-background-"));
    roots.push(root);
    let intact = true;
    const sandbox = new ReadWallLocalSandbox({
      workingDirectory: root,
      isolation: "none",
      env: { PATH: process.env.PATH },
      verifyReadWallIntegrity: async () => {
        if (!intact) throw new Error("profile hash changed");
      },
    });

    const handle = await sandbox.processes.spawn("printf background-ok");
    await expect(handle.wait()).resolves.toMatchObject({ exitCode: 0, stdout: "background-ok" });
    intact = false;
    await expect(sandbox.processes.spawn("printf leaked")).rejects.toThrow(/hash changed/);
    expect(sandbox.isReadWallHealthy()).toBe(false);
    await expect(sandbox.processes.spawn("printf retry")).rejects.toThrow(/commands are disabled/);
    await expect(sandbox.executeCommand!("printf foreground-retry")).rejects.toThrow(
      /commands are disabled/,
    );
  });

  it("后台进程启动失败后永久熔断 Workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-read-wall-background-launch-"));
    roots.push(root);
    const sandbox = new ReadWallLocalSandbox({
      workingDirectory: root,
      isolation: "none",
      env: { PATH: process.env.PATH },
      verifyReadWallIntegrity: async () => undefined,
    });

    await expect(
      sandbox.processes.spawn("printf unreachable", { cwd: join(root, "missing") }),
    ).rejects.toThrow();
    expect(sandbox.isReadWallHealthy()).toBe(false);
    await expect(sandbox.processes.spawn("printf retry")).rejects.toThrow(/commands are disabled/);
  });

  it("策略完整性变化后当前与后续命令均熔断", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-read-wall-sandbox-"));
    roots.push(root);
    await mkdir(join(root, "workspace"), { recursive: true });
    let intact = true;
    const sandbox = new ReadWallLocalSandbox({
      workingDirectory: join(root, "workspace"),
      isolation: "none",
      env: { PATH: process.env.PATH },
      verifyReadWallIntegrity: async () => {
        if (!intact) throw new Error("profile hash changed");
      },
    });
    await expect(sandbox.executeCommand!("printf ok")).resolves.toMatchObject({ exitCode: 0 });
    intact = false;
    await expect(sandbox.executeCommand!("printf leaked")).rejects.toThrow(/hash changed/);
    expect(sandbox.isReadWallHealthy()).toBe(false);
    await expect(sandbox.executeCommand!("printf retry")).rejects.toThrow(/commands are disabled/);
  });

  it("普通子命令伪造隔离器 stderr 前缀不会熔断后续命令", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-read-wall-stderr-"));
    roots.push(root);
    const sandbox = new ReadWallLocalSandbox({
      workingDirectory: root,
      isolation: "none",
      env: { PATH: process.env.PATH },
      verifyReadWallIntegrity: async () => undefined,
    });

    for (const prefix of ["bwrap", "sandbox-exec"]) {
      await expect(
        sandbox.executeCommand!(`printf '${prefix}: forged failure\\n' >&2; exit 7`),
      ).resolves.toMatchObject({
        exitCode: 7,
        stderr: `${prefix}: forged failure\n`,
      });
    }
    expect(sandbox.isReadWallHealthy()).toBe(true);
    await expect(sandbox.executeCommand!("printf still-available")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "still-available",
    });
  });

  it("隔离启动阶段的结构化失败仍会永久熔断", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-read-wall-launch-"));
    roots.push(root);
    const sandbox = new ReadWallLocalSandbox({
      workingDirectory: root,
      isolation: "none",
      verifyReadWallIntegrity: async () => undefined,
    });
    vi.spyOn(sandbox.processes, "spawn").mockRejectedValueOnce(
      new Error("isolation runtime failed to launch"),
    );

    await expect(sandbox.executeCommand!("printf unreachable")).rejects.toThrow(/failed to launch/);
    expect(sandbox.isReadWallHealthy()).toBe(false);
    await expect(sandbox.executeCommand!("printf retry")).rejects.toThrow(/commands are disabled/);
  });

  it("read-wall 模式硬禁 sandbox.mount()，调用即永久熔断", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-read-wall-mount-"));
    roots.push(root);
    const sandbox = new ReadWallLocalSandbox({
      workingDirectory: root,
      isolation: "none",
      verifyReadWallIntegrity: async () => undefined,
    });
    await expect(sandbox.mount({} as never, "/forbidden")).rejects.toThrow(/forbids sandbox\.mount/);
    expect(sandbox.isReadWallHealthy()).toBe(false);
  });

  it("Linux 被强制为 bwrap 但当前二进制/预检不可用时不装 sandbox、不暴露命令", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "bwrap";
    process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS = "1";
    const workspace = await getSessionWorkspace("read-wall-fail-closed", { resolveSkillDirs: () => [] });
    expect(workspace.sandbox).toBeUndefined();
  });

  it("Mac profile 构造/预检失败时不退回 Mastra 默认宽松 Seatbelt", async () => {
    process.env.QINGAGENT_SANDBOX_ISOLATION = "seatbelt";
    const workspace = await getSessionWorkspace("read-wall-seatbelt-fail-closed", { resolveSkillDirs: () => [] });
    expect(workspace.sandbox).toBeUndefined();
  });
});
