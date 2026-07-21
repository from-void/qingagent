import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "@mastra/core/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBubblewrapReadWallArgs } from "../workspace/readWallBubblewrap.js";
import { runReadWallProcess } from "../workspace/readWallProcess.js";
import { resolveReadWallPolicy } from "../workspace/readWallPolicy.js";
import { ReadWallLocalSandbox } from "../workspace/readWallSandbox.js";

const binaryCheck = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
const namespaceCheck = binaryCheck.status === 0
  ? spawnSync("bwrap", [
      "--unshare-user",
      "--unshare-pid",
      "--ro-bind-try", "/usr", "/usr",
      "--ro-bind-try", "/bin", "/bin",
      "--ro-bind-try", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--proc", "/proc",
      "--", "/usr/bin/true",
    ], { encoding: "utf8" })
  : null;
const bwrapUsable = binaryCheck.status === 0 && namespaceCheck?.status === 0;

interface LinuxBehaviorFixture {
  root: string;
  home: string;
  dataDir: string;
  sessionA: string;
  sessionB: string;
  binDir: string;
  skillsDir: string;
  userSkillsDir: string;
  argsA: string[];
  argsB: string[];
  env: NodeJS.ProcessEnv;
}

let fixture: LinuxBehaviorFixture;

async function buildFixture(): Promise<LinuxBehaviorFixture> {
  const root = await mkdtemp(join(tmpdir(), "qingagent-read-wall-behavior-"));
  const home = join(root, "home");
  const dataDir = join(home, "data");
  const sessionA = join(dataDir, "sessions", "a");
  const sessionB = join(dataDir, "sessions", "b");
  const binDir = join(dataDir, "bin");
  const skillsDir = join(home, "product", "skills");
  const userSkillsDir = join(home, ".qingagent", "skills");
  await Promise.all([
    mkdir(join(home, ".ssh"), { recursive: true }),
    mkdir(sessionA, { recursive: true }),
    mkdir(sessionB, { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(skillsDir, { recursive: true }),
    mkdir(userSkillsDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(home, ".ssh", "id_test"), "host-private-key"),
    writeFile(join(home, "ordinary.txt"), "ordinary-home-file"),
    writeFile(join(sessionB, "other-session.txt"), "other-session-secret"),
    writeFile(join(skillsDir, "SKILL.md"), "read-only-skill"),
    writeFile(join(binDir, "qa-read-wall-probe"), "#!/bin/sh\nprintf bin-ok"),
  ]);
  await chmod(join(binDir, "qa-read-wall-probe"), 0o755);
  await symlink(join(home, ".ssh", "id_test"), join(sessionA, "ssh-link"));

  const policyOptions = {
    platform: "linux" as const,
    env: { HOME: home },
    dataDir,
    sandboxBinDir: binDir,
    builtinSkillsDir: skillsDir,
    userSkillsDir,
    extraReadOnlyPaths: [],
    effectiveUid: typeof process.geteuid === "function" ? process.geteuid() : -1,
    effectiveHome: home,
  };
  const policyA = await resolveReadWallPolicy({ ...policyOptions, sessionDir: sessionA });
  const policyB = await resolveReadWallPolicy({ ...policyOptions, sessionDir: sessionB });
  const argsA = (await buildBubblewrapReadWallArgs(policyA, process.execPath)).args;
  const argsB = (await buildBubblewrapReadWallArgs(policyB, process.execPath)).args;
  return {
    root,
    home,
    dataDir,
    sessionA,
    sessionB,
    binDir,
    skillsDir,
    userSkillsDir,
    argsA,
    argsB,
    env: { HOME: home, PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin` },
  };
}

async function run(args: string[], command: string) {
  return runReadWallProcess("bwrap", [...args, "--", "sh", "-c", command], {
    env: fixture.env,
    cwd: fixture.sessionA,
    timeoutMs: 20_000,
  });
}

describe.skipIf(!bwrapUsable)("Linux read-wall 真行为探针", () => {
  beforeAll(async () => {
    fixture = await buildFixture();
  });
  afterAll(async () => {
    if (fixture?.root) await rm(fixture.root, { recursive: true, force: true });
  });

  it("deny 凭据失败、非 deny home 可读、当前 session 可写", async () => {
    expect((await run(fixture.argsA, "cat ~/.ssh/id_test")).exitCode).not.toBe(0);
    const ordinary = await run(fixture.argsA, "cat ~/ordinary.txt");
    expect(ordinary).toMatchObject({ exitCode: 0, stdout: "ordinary-home-file" });
    const session = await run(fixture.argsA, "printf session-ok > created.txt && cat created.txt");
    expect(session).toMatchObject({ exitCode: 0, stdout: "session-ok" });
  });

  it("skills/bin 可读可执行但不可写", async () => {
    expect((await run(fixture.argsA, "cat " + JSON.stringify(join(fixture.skillsDir, "SKILL.md")))).stdout)
      .toBe("read-only-skill");
    expect((await run(fixture.argsA, "qa-read-wall-probe")).stdout).toBe("bin-ok");
    expect((await run(fixture.argsA, "printf nope > " + JSON.stringify(join(fixture.skillsDir, "blocked")))).exitCode)
      .not.toBe(0);
    expect((await run(fixture.argsA, "printf nope > " + JSON.stringify(join(fixture.binDir, "blocked")))).exitCode)
      .not.toBe(0);
  });

  it("session symlink 指向 ~/.ssh 仍不可读", async () => {
    expect((await run(fixture.argsA, "cat ssh-link")).exitCode).not.toBe(0);
  });

  it("deny 目标构造时不存在、宿主随后创建，复用原 args 仍不可见", async () => {
    await mkdir(join(fixture.home, ".aws"), { recursive: true });
    await writeFile(join(fixture.home, ".aws", "credentials"), "late-secret");
    expect((await run(fixture.argsA, "cat ~/.aws/credentials")).exitCode).not.toBe(0);
  });

  it("两 session 互读隔离", async () => {
    expect((await run(fixture.argsA, "cat " + JSON.stringify(join(fixture.sessionB, "other-session.txt")))).exitCode)
      .not.toBe(0);
    expect((await run(fixture.argsB, "cat " + JSON.stringify(join(fixture.sessionA, "created.txt")))).exitCode)
      .not.toBe(0);
  });

  it("workspace.init 后重复实读 deny 仍失败", async () => {
    const sandbox = new ReadWallLocalSandbox({
      workingDirectory: fixture.sessionA,
      isolation: "bwrap",
      nativeSandbox: { allowNetwork: true, bwrapArgs: fixture.argsA },
      env: fixture.env,
      verifyReadWallIntegrity: async () => undefined,
    });
    const workspace = new Workspace({ sandbox });
    await workspace.init();
    const first = await sandbox.executeCommand!("cat ~/.ssh/id_test");
    const second = await sandbox.executeCommand!("cat ~/.ssh/id_test");
    expect(first.exitCode).not.toBe(0);
    expect(second.exitCode).not.toBe(0);
    await workspace.destroy();
  });
});
