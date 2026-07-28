import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  READ_WALL_POLICY_VERSION,
  resolveReadWallPath,
  resolveReadWallPolicy,
  type ResolveReadWallPolicyOptions,
} from "../workspace/readWallPolicy.js";

const roots: string[] = [];

async function fixture(platform: "linux" | "darwin" = "linux"): Promise<ResolveReadWallPolicyOptions> {
  const root = await mkdtemp(join(tmpdir(), "qingagent-read-wall-policy-"));
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

describe("read-wall deny v1 与路径解析", () => {
  it("Linux 清单覆盖通用凭据、Lark、密钥仓、浏览器、env 与 append-only 扩展", async () => {
    const options = await fixture("linux");
    const home = options.effectiveHome!;
    options.env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, "xdg"),
      AWS_SHARED_CREDENTIALS_FILE: join(home, "custom", "aws-creds"),
      AWS_CONFIG_FILE: join(home, "custom", "aws-config"),
      KUBECONFIG: [join(home, "custom", "kube-a"), join(home, "custom", "kube-b")].join(":"),
      CLOUDSDK_CONFIG: join(home, "custom", "gcloud"),
      NPM_CONFIG_USERCONFIG: join(home, "custom", "npmrc"),
      DOCKER_CONFIG: join(home, "custom", "docker"),
      QINGAGENT_SANDBOX_EXTRA_DENY_PATHS_JSON: JSON.stringify([
        { path: join(home, "custom", "vault"), type: "directory" },
        { path: join(home, "custom", "token"), type: "file" },
      ]),
    };
    const policy = await resolveReadWallPolicy(options);
    const lexical = policy.credentialDenyPaths.map((path) => path.lexicalPath);
    expect(policy.version).toBe(READ_WALL_POLICY_VERSION);
    expect(lexical).toEqual(expect.arrayContaining([
      join(home, ".ssh"),
      join(home, ".lark-cli"),
      join(home, ".docker", "run"),
      join(home, ".local", "share", "keyrings"),
      join(home, "xdg", "google-chrome"),
      join(home, ".mozilla", "firefox"),
      join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
      join(home, "custom", "aws-creds"),
      join(home, "custom", "kube-b"),
      join(home, "custom", "docker"),
      join(home, "custom", "vault"),
      join(home, "custom", "token"),
    ]));
    expect(policy.credentialDenyPaths.find((path) => path.lexicalPath.endsWith("aws-creds"))?.type).toBe("file");
    expect(policy.credentialDenyPaths.find((path) => path.lexicalPath.endsWith("vault"))?.type).toBe("directory");
  });

  it("macOS 清单包含浏览器与用户/机器钥匙串，但不 deny 系统信任根", async () => {
    const options = await fixture("darwin");
    const policy = await resolveReadWallPolicy(options);
    const lexical = policy.credentialDenyPaths.map((path) => path.lexicalPath);
    expect(lexical).toContain(join(options.effectiveHome!, "Library", "Keychains"));
    expect(lexical).toContain("/Library/Keychains");
    expect(lexical).toContain(join(options.effectiveHome!, "Library", "Containers", "com.apple.Safari"));
    expect(lexical).not.toContain("/System/Library/Keychains");
  });

  it("HOME 与 effective UID home 不一致时两套 home 都进入 deny 并记录告警", async () => {
    const options = await fixture();
    const declaredHome = join(options.effectiveHome!, "declared-home");
    await mkdir(declaredHome, { recursive: true });
    options.env.HOME = declaredHome;
    const policy = await resolveReadWallPolicy(options);
    expect(policy.warnings).toContain("HOME_MISMATCH_EFFECTIVE_UID");
    expect(policy.credentialDenyPaths.map((path) => path.lexicalPath)).toEqual(expect.arrayContaining([
      join(options.effectiveHome!, ".ssh"),
      join(declaredHome, ".ssh"),
    ]));
  });

  it("canonical 解析保留 lexical，并从最近现存祖先拼回未创建尾部", async () => {
    const options = await fixture();
    const home = options.effectiveHome!;
    const realConfig = join(home, "real-config");
    await mkdir(realConfig, { recursive: true });
    await symlink(realConfig, join(home, "config-link"));
    const resolved = await resolveReadWallPath(join(home, "config-link", "future", "token"), "file", home);
    expect(resolved.lexicalPath).toBe(join(home, "config-link", "future", "token"));
    expect(resolved.canonicalPath).toBe(join(realConfig, "future", "token"));
  });

  it("skills symlink 指向 ~/.ssh 时判定 deny 冲突并 fail-closed", async () => {
    const options = await fixture();
    const home = options.effectiveHome!;
    const ssh = join(home, ".ssh");
    await mkdir(ssh, { recursive: true });
    await rm(options.userSkillsDir, { recursive: true, force: true });
    await symlink(ssh, options.userSkillsDir);
    await expect(resolveReadWallPolicy(options)).rejects.toThrow(/overlaps a credential deny/);
  });

  it("session/bin 脱离 QINGAGENT_DATA_DIR 或 extra 试图重开 data 时拒绝", async () => {
    const options = await fixture();
    const outside = join(options.effectiveHome!, "outside");
    await mkdir(outside, { recursive: true });
    await expect(resolveReadWallPolicy({ ...options, sessionDir: outside })).rejects.toThrow(/contained/);
    await expect(resolveReadWallPolicy({ ...options, extraReadOnlyPaths: [options.dataDir] })).rejects.toThrow(
      /may only reopen/,
    );
  });

  it.each(["sessionDir", "sandboxBinDir"] as const)(
    "%s 词法位于 dataDir 但真实路径经符号链接逃逸时拒绝",
    async (pathKey) => {
      const options = await fixture();
      const outside = join(options.effectiveHome!, `outside-${pathKey}`);
      const link = join(options.dataDir, `outside-link-${pathKey}`);
      await mkdir(outside, { recursive: true });
      await symlink(outside, link);

      await expect(
        resolveReadWallPolicy({ ...options, [pathKey]: join(link, "not-created-yet") }),
      ).rejects.toThrow(/canonically contained/);
    },
  );

  it("非法 XDG、相对 env 路径、坏 append-only JSON 与控制字符全部拒绝", async () => {
    const options = await fixture();
    await expect(resolveReadWallPolicy({ ...options, env: { ...options.env, XDG_CONFIG_HOME: "relative" } }))
      .rejects.toThrow(/XDG_CONFIG_HOME/);
    await expect(resolveReadWallPolicy({ ...options, env: { ...options.env, AWS_CONFIG_FILE: "relative" } }))
      .rejects.toThrow(/AWS_CONFIG_FILE/);
    await expect(resolveReadWallPolicy({
      ...options,
      env: { ...options.env, QINGAGENT_SANDBOX_EXTRA_DENY_PATHS_JSON: "{}" },
    })).rejects.toThrow(/must be an array/);
    await expect(resolveReadWallPath(`${options.effectiveHome!}/bad\u0000path`, "file", options.effectiveHome!))
      .rejects.toThrow(/control character/);
  });

  it("单文件规则保持 file 类型，不会被误当目录", async () => {
    const options = await fixture();
    await writeFile(join(options.effectiveHome!, ".npmrc"), "token=secret");
    const policy = await resolveReadWallPolicy(options);
    expect(policy.credentialDenyPaths.find((path) => path.lexicalPath.endsWith(".npmrc"))?.type).toBe("file");
  });

  it("现存 deny 路径类型与 v1 声明不符时拒绝，避免 literal/subpath 失配", async () => {
    const options = await fixture();
    await mkdir(join(options.effectiveHome!, ".npmrc"), { recursive: true });
    await expect(resolveReadWallPolicy(options)).rejects.toThrow(/declared file\/directory type/);
  });
});
