import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveReadWallPolicy,
  type ResolveReadWallPolicyOptions,
} from "../workspace/readWallPolicy.js";
import { buildSeatbeltReadWallProfile } from "../workspace/readWallSeatbelt.js";
import { buildBubblewrapReadWallArgs } from "../workspace/readWallBubblewrap.js";

const roots: string[] = [];

async function fixture(platform: "linux" | "darwin"): Promise<ResolveReadWallPolicyOptions> {
  const root = await mkdtemp(join(tmpdir(), "qingagent-credential-wall-"));
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
    mkdir(join(home, ".lark-cli"), { recursive: true }),
    mkdir(join(home, ".ssh"), { recursive: true }),
    mkdir(join(home, ".local", "share", "keyrings"), { recursive: true }),
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function denyLexicalPaths(paths: { lexicalPath: string }[]): string[] {
  return paths.map((path) => path.lexicalPath);
}

describe("凭证授权对读墙的作用", () => {
  it("未授权时 .lark-cli 仍在 deny,且没有凭证例外", async () => {
    const options = await fixture("linux");
    const policy = await resolveReadWallPolicy(options);
    expect(denyLexicalPaths(policy.credentialDenyPaths)).toContain(
      join(options.effectiveHome!, ".lark-cli"),
    );
    expect(policy.allowPaths.some((path) => path.kind === "credential")).toBe(false);
    expect(policy.credentialWallMode).toBe("standard");
    expect(policy.writableHome).toBe(false);
  });

  it("授权后该路径退出 deny 并成为可写例外,其余凭证目录不受影响", async () => {
    const options = await fixture("linux");
    const home = options.effectiveHome!;
    const policy = await resolveReadWallPolicy({
      ...options,
      grantedCredentialPaths: [join(home, ".lark-cli")],
    });
    expect(denyLexicalPaths(policy.credentialDenyPaths)).not.toContain(join(home, ".lark-cli"));
    expect(denyLexicalPaths(policy.credentialDenyPaths)).toContain(join(home, ".ssh"));
    const credential = policy.allowPaths.find((path) => path.kind === "credential");
    expect(credential).toMatchObject({
      lexicalPath: join(home, ".lark-cli"),
      writable: true,
      exists: true,
      type: "directory",
    });
  });

  it("凭证文件形态(非目录)也能授权", async () => {
    const options = await fixture("linux");
    const home = options.effectiveHome!;
    await writeFile(join(home, ".netrc"), "machine example.com\n", "utf8");
    const policy = await resolveReadWallPolicy({
      ...options,
      grantedCredentialPaths: [join(home, ".netrc")],
    });
    expect(policy.allowPaths.find((path) => path.kind === "credential")).toMatchObject({
      type: "file",
      writable: true,
    });
    expect(denyLexicalPaths(policy.credentialDenyPaths)).not.toContain(join(home, ".netrc"));
  });

  it("命中永不放行项的授权被丢弃并留下告警", async () => {
    const options = await fixture("linux");
    const home = options.effectiveHome!;
    const policy = await resolveReadWallPolicy({
      ...options,
      grantedCredentialPaths: [join(home, ".local", "share", "keyrings")],
    });
    expect(policy.allowPaths.some((path) => path.kind === "credential")).toBe(false);
    expect(policy.warnings).toContain("CREDENTIAL_GRANT_HITS_PERMANENT_DENY");
    expect(denyLexicalPaths(policy.credentialDenyPaths)).toContain(
      join(home, ".local", "share", "keyrings"),
    );
  });

  it("HOME 之外的授权被丢弃", async () => {
    const options = await fixture("linux");
    const policy = await resolveReadWallPolicy({
      ...options,
      grantedCredentialPaths: ["/etc"],
    });
    expect(policy.allowPaths.some((path) => path.kind === "credential")).toBe(false);
    expect(policy.warnings).toContain("CREDENTIAL_GRANT_OUTSIDE_HOME");
  });

  it("最宽档整体豁免凭证黑名单,但永不放行项照旧 deny", async () => {
    const options = await fixture("linux");
    const home = options.effectiveHome!;
    const policy = await resolveReadWallPolicy({ ...options, credentialWallMode: "wide" });
    const denies = denyLexicalPaths(policy.credentialDenyPaths);
    expect(denies).not.toContain(join(home, ".ssh"));
    expect(denies).not.toContain(join(home, ".lark-cli"));
    expect(denies).toContain(join(home, ".local", "share", "keyrings"));
    expect(policy.writableHome).toBe(true);
  });
});

describe("seatbelt(darwin)渲染", () => {
  it("授权路径同时拿到读与写规则,且排在凭证 deny 之后", async () => {
    const options = await fixture("darwin");
    const home = options.effectiveHome!;
    const policy = await resolveReadWallPolicy({
      ...options,
      grantedCredentialPaths: [join(home, ".lark-cli")],
    });
    const profile = buildSeatbeltReadWallProfile(policy);
    const allowRead = `(allow file-read* (subpath "${join(home, ".lark-cli")}"))`;
    const allowWrite = `(allow file-write* (subpath "${join(home, ".lark-cli")}"))`;
    expect(profile).toContain(allowRead);
    expect(profile).toContain(allowWrite);
    expect(profile).not.toContain(`(deny file-read* (subpath "${join(home, ".lark-cli")}"))`);
    // SBPL 后规则覆盖前规则:凭证 allow 必须排在 .ssh 这类 deny 之后。
    expect(profile.indexOf(allowWrite)).toBeGreaterThan(
      profile.indexOf(`(deny file-read* (subpath "${join(home, ".ssh")}"))`),
    );
  });

  it("未授权时不出现任何凭证写规则", async () => {
    const options = await fixture("darwin");
    const home = options.effectiveHome!;
    const profile = buildSeatbeltReadWallProfile(await resolveReadWallPolicy(options));
    expect(profile).toContain(`(deny file-read* (subpath "${join(home, ".lark-cli")}"))`);
    expect(profile).not.toContain(`(allow file-write* (subpath "${join(home, ".lark-cli")}"))`);
  });

  it("最宽档写墙放开到 HOME,浏览器/钥匙串读写都仍被拒", async () => {
    const options = await fixture("darwin");
    const home = options.effectiveHome!;
    const externalSkills = join(home, ".claude", "skills");
    await mkdir(externalSkills, { recursive: true });
    const policy = await resolveReadWallPolicy({
      ...options,
      extraUserSkillsDirs: [externalSkills],
      credentialWallMode: "wide",
    });
    const profile = buildSeatbeltReadWallProfile(policy);
    expect(profile).toContain(`(allow file-write* (subpath "${home}"))`);
    expect(profile).toContain(
      `(deny file-read* (subpath "${join(home, "Library", "Keychains")}"))`,
    );
    expect(profile).toContain(
      `(deny file-write* (subpath "${join(home, "Library", "Keychains")}"))`,
    );
    // 写墙放开发生在永久 deny 之前,收回写权限的规则必须排在它之后。
    expect(profile.indexOf(`(deny file-write* (subpath "${join(home, "Library", "Keychains")}"))`))
      .toBeGreaterThan(profile.indexOf(`(allow file-write* (subpath "${home}"))`));
    const externalDeny = `(deny file-write* (subpath "${externalSkills}"))`;
    expect(profile).toContain(externalDeny);
    expect(profile.indexOf(externalDeny))
      .toBeGreaterThan(profile.indexOf(`(allow file-write* (subpath "${home}"))`));
  });
});

describe("bubblewrap(linux)渲染", () => {
  function bindPairs(args: string[], flag: string): string[] {
    const pairs: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === flag) pairs.push(`${args[index + 1]}=>${args[index + 2]}`);
    }
    return pairs;
  }

  it("授权路径拿到可写 bind,且排在只读投影之后", async () => {
    const options = await fixture("linux");
    const home = options.effectiveHome!;
    const policy = await resolveReadWallPolicy({
      ...options,
      grantedCredentialPaths: [join(home, ".lark-cli")],
    });
    const built = await buildBubblewrapReadWallArgs(policy, process.execPath);
    const credential = join(home, ".lark-cli");
    expect(bindPairs(built.args, "--bind")).toContain(`${credential}=>${credential}`);
    const writeIndex = built.args.lastIndexOf(credential);
    const readOnlyIndex = built.args.indexOf("--ro-bind");
    expect(writeIndex).toBeGreaterThan(readOnlyIndex);
  });

  it("未授权时凭证目录既不投影也没有可写 bind", async () => {
    const options = await fixture("linux");
    const home = options.effectiveHome!;
    const built = await buildBubblewrapReadWallArgs(await resolveReadWallPolicy(options), process.execPath);
    const credential = join(home, ".lark-cli");
    expect(built.args).not.toContain(credential);
  });

  it("最宽档 HOME 内条目以可写方式 bind 且不再只读重挂", async () => {
    const options = await fixture("linux");
    const home = options.effectiveHome!;
    const externalSkills = join(home, ".codex", "skills");
    await mkdir(externalSkills, { recursive: true });
    const policy = await resolveReadWallPolicy({
      ...options,
      extraUserSkillsDirs: [externalSkills],
      credentialWallMode: "wide",
    });
    const built = await buildBubblewrapReadWallArgs(policy, process.execPath);
    expect(bindPairs(built.args, "--bind").some((pair) => pair.startsWith(join(home, ".ssh")))).toBe(true);
    expect(bindPairs(built.args, "--ro-bind")).toContain(
      `${externalSkills}=>${externalSkills}`,
    );
    const remountIndex = built.args.indexOf("--remount-ro");
    const remounted = remountIndex === -1 ? [] : built.args.filter((_, index) =>
      built.args[index - 1] === "--remount-ro",
    );
    expect(remounted).not.toContain(home);
  });
});
