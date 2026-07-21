import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildBubblewrapReadWallArgs,
  buildStrictFallbackBwrapArgs,
  prepareBubblewrapReadWallPolicy,
  validateBubblewrapArgsContract,
} from "../workspace/readWallBubblewrap.js";
import type { ReadWallProcessRunner } from "../workspace/readWallProcess.js";
import { resolveReadWallPolicy } from "../workspace/readWallPolicy.js";

const roots: string[] = [];

async function linuxFixture() {
  const root = await mkdtemp(join(tmpdir(), "qingagent-read-wall-bwrap-"));
  roots.push(root);
  const home = join(root, "home");
  const dataDir = join(home, "app-data");
  const sessionDir = join(dataDir, "sessions", "current");
  const sandboxBinDir = join(dataDir, "bin");
  const builtinSkillsDir = join(home, "product", "skills");
  const userSkillsDir = join(home, ".qingagent", "skills");
  await Promise.all([
    mkdir(join(home, ".ssh"), { recursive: true }),
    mkdir(join(home, ".config", "safe-tool"), { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
    mkdir(sandboxBinDir, { recursive: true }),
    mkdir(builtinSkillsDir, { recursive: true }),
    mkdir(userSkillsDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(home, ".ssh", "id_test"), "secret"),
    writeFile(join(home, "ordinary.txt"), "ordinary"),
    writeFile(join(home, ".config", "safe-tool", "config"), "safe"),
    writeFile(join(builtinSkillsDir, "SKILL.md"), "skill"),
    writeFile(join(sandboxBinDir, "tool"), "#!/bin/sh\nexit 0\n"),
  ]);
  await symlink(join(home, ".ssh"), join(home, "credential-link"));
  const policy = await resolveReadWallPolicy({
    platform: "linux",
    env: { HOME: home },
    dataDir,
    sessionDir,
    sandboxBinDir,
    builtinSkillsDir,
    userSkillsDir,
    extraReadOnlyPaths: [],
    effectiveUid: typeof process.geteuid === "function" ? process.geteuid() : -1,
    effectiveHome: home,
  });
  return { root, home, dataDir, sessionDir, sandboxBinDir, builtinSkillsDir, userSkillsDir, policy };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

describe("Linux Bubblewrap deny-aware home 投影", () => {
  it("完整重建 namespace/proc/tmp/系统挂载/node/chdir/die-with-parent，且不添加终止 --", async () => {
    const fixture = await linuxFixture();
    const built = await buildBubblewrapReadWallArgs(fixture.policy, process.execPath);
    validateBubblewrapArgsContract(built.args, true);
    expect(built.args).toEqual(expect.arrayContaining([
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--chdir",
      fixture.sessionDir,
      "--die-with-parent",
    ]));
    expect(built.args).not.toContain("--");
    expect(built.args).not.toContain("--unshare-net");
    expect(flagValue(built.args, "--chdir")).toBe(fixture.sessionDir);
  });

  it("home 用 tmpfs 投影；deny 与指向 deny 的 symlink 不绑定；安全兄弟只读绑定", async () => {
    const fixture = await linuxFixture();
    const built = await buildBubblewrapReadWallArgs(fixture.policy, process.execPath);
    const serialized = JSON.stringify(built.args);
    expect(built.args).toEqual(expect.arrayContaining(["--tmpfs", fixture.home, "--remount-ro", fixture.home]));
    expect(serialized).not.toContain(join(fixture.home, ".ssh", "id_test"));
    expect(serialized).not.toContain(join(fixture.home, "credential-link"));
    expect(built.args).toEqual(expect.arrayContaining([
      "--ro-bind",
      join(fixture.home, "ordinary.txt"),
      join(fixture.home, "ordinary.txt"),
      "--tmpfs",
      join(fixture.home, ".config"),
      "--ro-bind",
      join(fixture.home, ".config", "safe-tool"),
      join(fixture.home, ".config", "safe-tool"),
    ]));
  });

  it("QINGAGENT_DATA_DIR 先空投影，只重开 session 写与 bin/skills 读", async () => {
    const fixture = await linuxFixture();
    const built = await buildBubblewrapReadWallArgs(fixture.policy, process.execPath);
    const dataTmpfs = built.args.findIndex(
      (value, index) => value === "--tmpfs" && built.args[index + 1] === fixture.dataDir,
    );
    const sessionBind = built.args.findIndex(
      (value, index) => value === "--bind" && built.args[index + 1] === fixture.sessionDir,
    );
    const binBind = built.args.findIndex(
      (value, index) => value === "--ro-bind" && built.args[index + 1] === fixture.sandboxBinDir,
    );
    const dataRemount = built.args.findIndex(
      (value, index) => value === "--remount-ro" && built.args[index + 1] === fixture.dataDir,
    );
    expect(dataTmpfs).toBeGreaterThanOrEqual(0);
    expect(sessionBind).toBeGreaterThan(dataTmpfs);
    expect(binBind).toBeGreaterThan(dataTmpfs);
    expect(dataRemount).toBeGreaterThan(sessionBind);
    expect(dataRemount).toBeGreaterThan(binBind);
  });

  it("严格 fallback 保持 home 不可见，并仍完整装配 Mastra 基线", async () => {
    const fixture = await linuxFixture();
    const built = await buildStrictFallbackBwrapArgs(fixture.policy, process.execPath);
    validateBubblewrapArgsContract(built.args, false);
    expect(built.mode).toBe("strict-fallback");
    expect(built.args).not.toContain(fixture.home);
    expect(built.args).toEqual(expect.arrayContaining(["--bind", fixture.sessionDir, fixture.sessionDir]));
  });

  it("custom 行为预检失败时只允许退到已预检的严格 baseline", async () => {
    const fixture = await linuxFixture();
    let bwrapCalls = 0;
    const runner = vi.fn<ReadWallProcessRunner>().mockImplementation(async (command, args) => {
      if (command === "bwrap" && args[0] === "--version") {
        return { exitCode: 0, stdout: "bubblewrap 0.11.0", stderr: "" };
      }
      bwrapCalls += 1;
      return bwrapCalls === 1
        ? { exitCode: 1, stdout: "", stderr: "bwrap: simulated read-wall failure" }
        : { exitCode: 0, stdout: "", stderr: "" };
    });
    const prepared = await prepareBubblewrapReadWallPolicy({
      policy: fixture.policy,
      env: { HOME: fixture.home, PATH: process.env.PATH },
      nodeExecutable: process.execPath,
      runner,
    });
    expect(prepared.mode).toBe("strict-fallback");
    expect(bwrapCalls).toBe(2);
  });

  it("bwrap 缺失时 fail-closed，不把 fallback 当 unsandboxed retry", async () => {
    const fixture = await linuxFixture();
    const runner: ReadWallProcessRunner = async () => ({ exitCode: 1, stdout: "", stderr: "ENOENT" });
    await expect(prepareBubblewrapReadWallPolicy({
      policy: fixture.policy,
      env: { HOME: fixture.home },
      nodeExecutable: process.execPath,
      runner,
    })).rejects.toThrow(/unavailable/);
  });

  it("冲突的 custom args 契约会阻断命令", () => {
    expect(() => validateBubblewrapArgsContract(["--unshare-pid"], true)).toThrow(/missing/);
    expect(() => validateBubblewrapArgsContract([
      "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
      "--proc", "/proc", "--tmpfs", "/tmp", "--chdir", "/tmp", "--die-with-parent", "--",
    ], true)).toThrow(/terminator/);
  });
});
