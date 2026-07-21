import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadWallProcessRunner } from "../workspace/readWallProcess.js";
import { resolveReadWallPolicy } from "../workspace/readWallPolicy.js";
import {
  buildSeatbeltReadWallProfile,
  prepareSeatbeltReadWallPolicy,
  validateSeatbeltReadWallProfile,
  verifySeatbeltProfileHash,
} from "../workspace/readWallSeatbelt.js";

const roots: string[] = [];

async function macFixture() {
  const root = await mkdtemp(join(tmpdir(), "qingagent-read-wall-seatbelt-"));
  roots.push(root);
  const home = join(root, "home");
  const dataDir = join(home, "data");
  const sessionDir = join(dataDir, "sessions", "current");
  const sandboxBinDir = join(dataDir, "bin");
  const builtinSkillsDir = join(home, "product", "skills");
  const userSkillsDir = join(home, ".qingagent", "skills");
  await Promise.all([
    mkdir(sessionDir, { recursive: true }),
    mkdir(sandboxBinDir, { recursive: true }),
    mkdir(builtinSkillsDir, { recursive: true }),
    mkdir(userSkillsDir, { recursive: true }),
  ]);
  const policy = await resolveReadWallPolicy({
    platform: "darwin",
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

describe("macOS Seatbelt 读墙", () => {
  it("生成完整基线、credential deny、data 分裂例外与 session 写权限", async () => {
    const fixture = await macFixture();
    const profile = buildSeatbeltReadWallProfile(fixture.policy);
    expect(profile).toContain("(allow file-read*)");
    expect(profile).toContain(`(deny file-read* (subpath ${JSON.stringify(join(fixture.home, ".ssh"))}))`);
    expect(profile).toContain(`(subpath ${JSON.stringify(fixture.dataDir)})`);
    expect(profile).toContain(`(require-not (subpath ${JSON.stringify(fixture.sessionDir)}))`);
    expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(fixture.sessionDir)}))`);
    expect(profile).toContain("com.apple.trustd.agent");
    expect(profile).not.toContain("com.apple.securityd.xpc");
    expect(profile).not.toContain("com.apple.SecurityServer");
    validateSeatbeltReadWallProfile(profile);
  });

  it("SBPL 路径统一按 JSON 字符串转义，不直接拼接引号路径", async () => {
    const fixture = await macFixture();
    const quotedPath = join(fixture.home, 'credential"quoted');
    await mkdir(quotedPath, { recursive: true });
    const policy = await resolveReadWallPolicy({
      platform: "darwin",
      env: {
        HOME: fixture.home,
        QINGAGENT_SANDBOX_EXTRA_DENY_PATHS_JSON: JSON.stringify([
          { path: quotedPath, type: "directory" },
        ]),
      },
      dataDir: fixture.dataDir,
      sessionDir: fixture.sessionDir,
      sandboxBinDir: fixture.sandboxBinDir,
      builtinSkillsDir: fixture.builtinSkillsDir,
      userSkillsDir: fixture.userSkillsDir,
      extraReadOnlyPaths: [],
      effectiveUid: typeof process.geteuid === "function" ? process.geteuid() : -1,
      effectiveHome: fixture.home,
    });
    expect(buildSeatbeltReadWallProfile(policy)).toContain(`(subpath ${JSON.stringify(quotedPath)})`);
  });

  it("原子生成后做语法/行为预检并复核 hash", async () => {
    const fixture = await macFixture();
    const runner = vi.fn<ReadWallProcessRunner>().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const prepared = await prepareSeatbeltReadWallPolicy({
      policy: fixture.policy,
      dataDir: fixture.dataDir,
      env: { HOME: fixture.home, PATH: process.env.PATH },
      runner,
    });
    expect(runner).toHaveBeenCalledWith(
      "sandbox-exec",
      expect.arrayContaining(["-p", prepared.profile, "sh", "-c"]),
      expect.objectContaining({ cwd: fixture.sessionDir }),
    );
    expect(await readFile(prepared.profilePath, "utf8")).toBe(prepared.profile);
    await expect(verifySeatbeltProfileHash(prepared.profilePath, prepared.profileHash)).resolves.toBeUndefined();
  });

  it("坏 SBPL/行为预检失败时不返回可交给 Mastra 的 profile", async () => {
    const fixture = await macFixture();
    const runner = vi.fn<ReadWallProcessRunner>().mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "sandbox-exec: profile syntax error",
    });
    await expect(prepareSeatbeltReadWallPolicy({
      policy: fixture.policy,
      dataDir: fixture.dataDir,
      env: { HOME: fixture.home, PATH: process.env.PATH },
      runner,
    })).rejects.toThrow(/preflight failed/);
  });

  it("profile 缺失或被改写时 hash guard fail-closed", async () => {
    const fixture = await macFixture();
    const runner: ReadWallProcessRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const prepared = await prepareSeatbeltReadWallPolicy({
      policy: fixture.policy,
      dataDir: fixture.dataDir,
      env: { HOME: fixture.home },
      runner,
    });
    await writeFile(prepared.profilePath, `${prepared.profile}\n; tampered`);
    await expect(verifySeatbeltProfileHash(prepared.profilePath, prepared.profileHash)).rejects.toThrow(/hash changed/);
    await rm(prepared.profilePath);
    await expect(verifySeatbeltProfileHash(prepared.profilePath, prepared.profileHash)).rejects.toThrow();
  });

  it("纯校验器拒绝不平衡 SBPL 与 Keychain Mach 服务", () => {
    expect(() => validateSeatbeltReadWallProfile('(version 1)\n(allow file-read*)\n(allow network*)'))
      .toThrow(/required baseline/);
    expect(() => validateSeatbeltReadWallProfile([
      "(version 1)",
      '(deny default (with message "qingagent-sandbox"))',
      "(allow file-read*)",
      "(allow network*)",
      '(allow mach-lookup (global-name "com.apple.trustd.agent")',
    ].join("\n"))).toThrow(/unbalanced/);
    expect(() => validateSeatbeltReadWallProfile([
      "(version 1)",
      '(deny default (with message "qingagent-sandbox"))',
      "(allow file-read*)",
      "(allow network*)",
      '(allow mach-lookup (global-name "com.apple.trustd.agent"))',
      '(allow mach-lookup (global-name "com.apple.securityd.xpc"))',
    ].join("\n"))).toThrow(/Keychain/);
  });
});
