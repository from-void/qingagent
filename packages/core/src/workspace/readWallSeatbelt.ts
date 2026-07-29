import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReadWallProcessResult, ReadWallProcessRunner } from "./readWallProcess.js";
import { runReadWallProcess, shellQuoteReadWallPath } from "./readWallProcess.js";
import type {
  ReadWallResolvedPolicy,
  ResolvedReadWallAllowPath,
  ResolvedReadWallPath,
} from "./readWallPolicy.js";

export interface PreparedSeatbeltPolicy {
  profile: string;
  profilePath: string;
  profileHash: string;
}

export interface PrepareSeatbeltPolicyOptions {
  policy: ReadWallResolvedPolicy;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  runner?: ReadWallProcessRunner;
}

const MACH_SERVICES = [
  "com.apple.distributed_notifications@Uv3",
  "com.apple.logd",
  "com.apple.system.logger",
  "com.apple.system.notification_center",
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.bsd.dirhelper",
  "com.apple.trustd.agent",
];

function sbplString(value: string): string {
  return JSON.stringify(value);
}

function pathVariants(path: ResolvedReadWallPath): string[] {
  return [...new Set([path.lexicalPath, path.canonicalPath])];
}

function renderCredentialDeny(path: ResolvedReadWallPath): string[] {
  const filter = path.type === "directory" ? "subpath" : "literal";
  return pathVariants(path).map((variant) => `(deny file-read* (${filter} ${sbplString(variant)}))`);
}

function renderDataDeny(
  dataPath: string,
  allowedExceptions: ResolvedReadWallAllowPath[],
): string[] {
  const exceptions = allowedExceptions
    .flatMap(pathVariants)
    .filter((exception) => exception === dataPath || exception.startsWith(`${dataPath}/`));
  if (exceptions.length === 0) return [`(deny file-read* (subpath ${sbplString(dataPath)}))`];
  return [
    "(deny file-read*",
    "  (require-all",
    `    (subpath ${sbplString(dataPath)})`,
    ...exceptions.map((exception) => `    (require-not (subpath ${sbplString(exception)}))`),
    "  )",
    ")",
  ];
}

function renderCredentialAllow(path: ResolvedReadWallAllowPath): string[] {
  const filter = path.type === "directory" ? "subpath" : "literal";
  // 读写两条都发:凭证目录要能被 CLI 刷新 token / 写锁文件,只放读会卡在"判未登录"死循环。
  return pathVariants(path).flatMap((variant) => [
    `(allow file-read* (${filter} ${sbplString(variant)}))`,
    `(allow file-write* (${filter} ${sbplString(variant)}))`,
  ]);
}

export function buildSeatbeltReadWallProfile(policy: ReadWallResolvedPolicy): string {
  if (policy.platform !== "darwin") throw new Error("seatbelt policy requires the darwin deny list");
  const readExceptions = policy.allowPaths.filter(
    (path) => path.kind !== "credential" && (path.kind !== "extra" || path.exists),
  );
  const credentialExceptions = policy.allowPaths.filter((path) => path.kind === "credential");
  const session = policy.allowPaths.find((path) => path.kind === "session");
  if (!session) throw new Error("seatbelt policy is missing the session exception");
  // session 已单独发写规则;credential 走后置的 renderCredentialAllow。
  const writableExceptions = policy.allowPaths.filter(
    (path) => path.writable && path.kind !== "session" && path.kind !== "credential",
  );

  const lines = [
    "(version 1)",
    '(deny default (with message "qingagent-sandbox"))',
    "",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    "",
    "(allow mach-lookup",
    ...MACH_SERVICES.map((service) => `  (global-name ${sbplString(service)})`),
    ")",
    "",
    "(allow ipc-posix-shm)",
    "(allow ipc-posix-sem)",
    "(allow user-preference-read)",
    "(allow sysctl-read)",
    "",
    "(allow file-ioctl",
    ...["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/tty"].map(
      (path) => `  (literal ${sbplString(path)})`,
    ),
    ")",
    "",
    "; 普通宿主文件默认只读透传，以下 deny 是产品内置安全下限。",
    "(allow file-read*)",
    ...policy.credentialDenyPaths.flatMap(renderCredentialDeny),
    ...pathVariants(policy.dataDenyPath).flatMap((path) => renderDataDeny(path, readExceptions)),
    "",
    "; QINGAGENT_DATA_DIR 只重开当前 session、bin 与 skills。",
    ...readExceptions.flatMap((path) =>
      pathVariants(path).map((variant) => `(allow file-read* (subpath ${sbplString(variant)}))`),
    ),
    ...pathVariants(session).map((path) => `(allow file-write* (subpath ${sbplString(path)}))`),
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/private/var/folders"))',
    "",
    "; 技能目录可写:装技能就是往这里写。只开技能目录,HOME 其余部分仍只读。",
    ...writableExceptions.flatMap((path) =>
      pathVariants(path).map((variant) => `(allow file-write* (subpath ${sbplString(variant)}))`),
    ),
    "",
    "; 用户授权共享的凭证路径:读放行 + 可写,与终端共用同一份登录态。",
    "; SBPL 后规则覆盖前规则,因此这里能盖掉上面的凭证 deny。",
    ...credentialExceptions.flatMap(renderCredentialAllow),
    ...(policy.writableHome
      ? [
          "",
          "; 最宽档:写墙放开到整个用户目录,随后把永久 deny 的写权限再收回去。",
          `(allow file-write* (subpath ${sbplString(policy.effectiveHome)}))`,
          ...policy.credentialDenyPaths.flatMap((path) =>
            pathVariants(path).map((variant) =>
              `(deny file-write* (${path.type === "directory" ? "subpath" : "literal"} ${sbplString(variant)}))`,
            ),
          ),
        ]
      : []),
    "",
    "(allow network*)",
  ];
  const profile = lines.join("\n");
  validateSeatbeltReadWallProfile(profile);
  return profile;
}

export function validateSeatbeltReadWallProfile(profile: string): void {
  const required = [
    "(version 1)",
    '(deny default (with message "qingagent-sandbox"))',
    "(allow file-read*)",
    "(allow network*)",
    "com.apple.trustd.agent",
  ];
  for (const marker of required) {
    if (!profile.includes(marker)) throw new Error("seatbelt profile is missing a required baseline rule");
  }
  if (profile.includes("com.apple.securityd.xpc") || profile.includes("com.apple.SecurityServer")) {
    throw new Error("seatbelt profile must not reopen Keychain Mach services");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of profile) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (depth < 0) throw new Error("seatbelt profile has an unmatched closing parenthesis");
  }
  if (inString || depth !== 0) throw new Error("seatbelt profile is syntactically unbalanced");
}

async function atomicCreateProfile(profilePath: string, profile: string): Promise<void> {
  const directory = dirname(profilePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const existing = await readFile(profilePath, "utf8");
    if (existing !== profile) throw new Error("seatbelt profile hash changed on disk");
    return;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }

  const temporaryPath = `${profilePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporaryPath, profile, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, profilePath);
    await chmod(profilePath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function verifySeatbeltProfileHash(profilePath: string, expectedHash: string): Promise<void> {
  const content = await readFile(profilePath, "utf8");
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (actualHash !== expectedHash) throw new Error("seatbelt profile is missing or its hash changed");
  validateSeatbeltReadWallProfile(content);
}

async function preflightSeatbeltPolicy(
  prepared: PreparedSeatbeltPolicy,
  policy: ReadWallResolvedPolicy,
  env: NodeJS.ProcessEnv,
  runner: ReadWallProcessRunner,
): Promise<void> {
  const session = policy.allowPaths.find((path) => path.kind === "session");
  if (!session) throw new Error("seatbelt preflight is missing the session path");
  const probeName = `.read-wall-preflight-${prepared.profileHash.slice(0, 12)}-${randomBytes(6).toString("hex")}`;
  const sessionProbe = join(session.lexicalPath, probeName);
  const deniedProbe = prepared.profilePath;
  const command = [
    `if cat ${shellQuoteReadWallPath(deniedProbe)}; then exit 41; fi`,
    `printf qingagent-read-wall > ${shellQuoteReadWallPath(sessionProbe)}`,
    `test "$(cat ${shellQuoteReadWallPath(sessionProbe)})" = qingagent-read-wall`,
    `rm -f ${shellQuoteReadWallPath(sessionProbe)}`,
    "test -r /etc/passwd",
  ].join(" && ");
  let result: ReadWallProcessResult;
  try {
    result = await runner(
      "sandbox-exec",
      ["-p", prepared.profile, "sh", "-c", command],
      { env, timeoutMs: 15_000, cwd: session.lexicalPath },
    );
  } finally {
    await rm(sessionProbe, { force: true }).catch(() => undefined);
  }
  if (result.exitCode !== 0) throw new Error("seatbelt syntax or behavior preflight failed");
}

export async function prepareSeatbeltReadWallPolicy(
  options: PrepareSeatbeltPolicyOptions,
): Promise<PreparedSeatbeltPolicy> {
  const profile = buildSeatbeltReadWallProfile(options.policy);
  const profileHash = createHash("sha256").update(profile).digest("hex");
  const profilePath = join(options.dataDir, "sandbox-policy", `seatbelt-${profileHash}.sb`);
  await atomicCreateProfile(profilePath, profile);
  const prepared = { profile, profilePath, profileHash };
  await verifySeatbeltProfileHash(profilePath, profileHash);
  await preflightSeatbeltPolicy(prepared, options.policy, options.env, options.runner ?? runReadWallProcess);
  await verifySeatbeltProfileHash(profilePath, profileHash);
  return prepared;
}
