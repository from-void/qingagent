import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReadWallProcessResult, ReadWallProcessRunner } from "./readWallProcess.js";
import { runReadWallProcess, shellQuoteReadWallPath } from "./readWallProcess.js";
import {
  readWallPathIsInside,
  readWallPathsOverlap,
  type ReadWallResolvedPolicy,
  type ResolvedReadWallAllowPath,
  type ResolvedReadWallPath,
} from "./readWallPolicy.js";

const SYSTEM_READONLY_BINDS = [
  "/usr",
  "/lib",
  "/lib64",
  "/bin",
  "/sbin",
  "/etc/alternatives",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/passwd",
  "/etc/group",
  "/etc/nsswitch.conf",
  "/etc/ld.so.cache",
  "/etc/localtime",
];

export interface BuiltBubblewrapPolicy {
  args: string[];
  safeHomeBindings: string[];
  mode: "read-wall" | "strict-fallback";
  hash: string;
}

export interface PrepareBubblewrapPolicyOptions {
  policy: ReadWallResolvedPolicy;
  env: NodeJS.ProcessEnv;
  nodeExecutable: string;
  runner?: ReadWallProcessRunner;
}

interface ProjectionContext {
  args: string[];
  denyPaths: ResolvedReadWallPath[];
  safeBindings: string[];
  projectedDestinations: Set<string>;
  visitedSources: Set<string>;
  remountReadOnly: Set<string>;
  /** 最宽档:HOME 投影内的条目直接以可写方式 bind,且不再只读重挂。 */
  writableHome: boolean;
  homeRoot: string;
}

function variants(path: ResolvedReadWallPath): string[] {
  return [...new Set([path.lexicalPath, path.canonicalPath])];
}

function allDenyVariants(paths: ResolvedReadWallPath[]): string[] {
  return [...new Set(paths.flatMap(variants))].sort((left, right) => left.localeCompare(right));
}

function nodeIsDenied(destination: string, canonicalSource: string, denyPaths: ResolvedReadWallPath[]): boolean {
  return allDenyVariants(denyPaths).some(
    (denied) => readWallPathIsInside(destination, denied) || readWallPathIsInside(canonicalSource, denied),
  );
}

function nodeContainsDeny(destination: string, canonicalSource: string, denyPaths: ResolvedReadWallPath[]): boolean {
  return allDenyVariants(denyPaths).some(
    (denied) => readWallPathIsInside(denied, destination) || readWallPathIsInside(denied, canonicalSource),
  );
}

async function pathKind(path: string): Promise<"directory" | "file" | "missing"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const canonical = await realpath(path);
      const target = await lstat(canonical);
      return target.isDirectory() ? "directory" : "file";
    }
    return info.isDirectory() ? "directory" : "file";
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return "missing";
    throw error;
  }
}

function addParentDirectories(args: string[], destination: string, created: Set<string>): void {
  const ancestors: string[] = [];
  let cursor = dirname(destination);
  while (cursor !== "/" && cursor !== ".") {
    ancestors.push(cursor);
    cursor = dirname(cursor);
  }
  for (const ancestor of ancestors.reverse()) {
    if (created.has(ancestor)) continue;
    args.push("--dir", ancestor);
    created.add(ancestor);
  }
}

async function projectDirectory(
  sourceRoot: string,
  destinationRoot: string,
  context: ProjectionContext,
): Promise<void> {
  const canonicalSourceRoot = await realpath(sourceRoot);
  if (context.visitedSources.has(canonicalSourceRoot)) return;
  context.visitedSources.add(canonicalSourceRoot);
  addParentDirectories(context.args, destinationRoot, context.projectedDestinations);
  context.args.push("--tmpfs", destinationRoot);
  context.projectedDestinations.add(destinationRoot);

  const entries = await readdir(canonicalSourceRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourcePath = join(canonicalSourceRoot, entry.name);
    const destinationPath = join(destinationRoot, entry.name);
    let canonicalSource: string;
    try {
      canonicalSource = await realpath(sourcePath);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") continue;
      throw error;
    }
    if (nodeIsDenied(destinationPath, canonicalSource, context.denyPaths)) continue;
    if (nodeContainsDeny(destinationPath, canonicalSource, context.denyPaths)) {
      if ((await pathKind(canonicalSource)) !== "directory") {
        throw new Error("bubblewrap deny descendant has a non-directory ancestor");
      }
      if (context.visitedSources.has(canonicalSource)) continue;
      await projectDirectory(canonicalSource, destinationPath, context);
      continue;
    }
    const writable = context.writableHome && readWallPathIsInside(destinationPath, context.homeRoot);
    context.args.push(writable ? "--bind" : "--ro-bind", canonicalSource, destinationPath);
    context.safeBindings.push(destinationPath);
  }
  if (!(context.writableHome && readWallPathIsInside(destinationRoot, context.homeRoot))) {
    context.remountReadOnly.add(destinationRoot);
  }
}

function isCoveredByRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => readWallPathIsInside(path, root));
}

async function appendReadonlyRoot(
  source: string,
  destination: string,
  denyPaths: ResolvedReadWallPath[],
  context: ProjectionContext,
  tryIfMissing: boolean,
): Promise<void> {
  const kind = await pathKind(source);
  if (kind === "missing") {
    if (tryIfMissing) context.args.push("--ro-bind-try", source, destination);
    return;
  }
  const canonicalSource = await realpath(source);
  if (nodeIsDenied(destination, canonicalSource, denyPaths)) return;
  if (kind === "directory" && nodeContainsDeny(destination, canonicalSource, denyPaths)) {
    await projectDirectory(canonicalSource, destination, context);
    return;
  }
  context.args.push(tryIfMissing ? "--ro-bind-try" : "--ro-bind", canonicalSource, destination);
  context.safeBindings.push(destination);
}

function allowInsideData(path: ResolvedReadWallAllowPath, dataPath: ResolvedReadWallPath): boolean {
  return variants(path).some((allowed) => variants(dataPath).some((data) => readWallPathIsInside(allowed, data)));
}

async function appendDataProjection(
  policy: ReadWallResolvedPolicy,
  context: ProjectionContext,
): Promise<void> {
  const dataDestination = policy.dataDenyPath.lexicalPath;
  addParentDirectories(context.args, dataDestination, context.projectedDestinations);
  context.args.push("--tmpfs", dataDestination);
  context.projectedDestinations.add(dataDestination);
  const exceptions = policy.allowPaths
    .filter((path) => allowInsideData(path, policy.dataDenyPath) && path.exists)
    .sort((left, right) => left.lexicalPath.localeCompare(right.lexicalPath));
  for (const exception of exceptions) {
    context.args.push(exception.writable ? "--bind" : "--ro-bind", exception.canonicalPath, exception.lexicalPath);
  }
  context.remountReadOnly.add(dataDestination);
}

function baselinePrefix(): string[] {
  return [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--proc",
    "/proc",
    // bwrap 自建的最小 devtmpfs(null/zero/full/random/urandom/tty)。缺了它 /dev 整个不存在,
    // 任何一句 `2>/dev/null` 都会以 "cannot create /dev/null" 直接失败。
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
}

export async function buildBubblewrapReadWallArgs(
  policy: ReadWallResolvedPolicy,
  nodeExecutable: string,
): Promise<BuiltBubblewrapPolicy> {
  if (policy.platform !== "linux") throw new Error("bubblewrap policy requires the linux deny list");
  const denyPaths = [...policy.credentialDenyPaths, policy.dataDenyPath];
  const args = baselinePrefix();
  const context: ProjectionContext = {
    args,
    denyPaths,
    safeBindings: [],
    projectedDestinations: new Set(["/tmp", "/proc", "/dev"]),
    visitedSources: new Set(),
    remountReadOnly: new Set(),
    writableHome: policy.writableHome,
    homeRoot: policy.effectiveHome,
  };

  for (const systemPath of SYSTEM_READONLY_BINDS) {
    await appendReadonlyRoot(systemPath, systemPath, denyPaths, context, true);
  }
  for (const optionalSystemPath of ["/opt", "/snap"]) {
    await appendReadonlyRoot(optionalSystemPath, optionalSystemPath, denyPaths, context, true);
  }

  await projectDirectory(policy.effectiveHome, policy.effectiveHome, context);
  await appendDataProjection(policy, context);

  const mountedRoots = [...SYSTEM_READONLY_BINDS, "/opt", "/snap", policy.effectiveHome];
  const explicitReadOnly = policy.allowPaths.filter(
    (path) =>
      path.exists &&
      !path.writable &&
      path.kind !== "credential" &&
      !allowInsideData(path, policy.dataDenyPath),
  );
  for (const allowed of explicitReadOnly) {
    if (isCoveredByRoot(allowed.lexicalPath, mountedRoots)) continue;
    await appendReadonlyRoot(allowed.canonicalPath, allowed.lexicalPath, denyPaths, context, false);
  }

  const nodeDir = dirname(await realpath(nodeExecutable));
  if (!isCoveredByRoot(nodeDir, mountedRoots)) {
    const nodeRule: ResolvedReadWallPath = {
      path: nodeDir,
      lexicalPath: nodeDir,
      canonicalPath: nodeDir,
      type: "directory",
    };
    if (denyPaths.some((denied) => readWallPathsOverlap(nodeRule, denied))) {
      throw new Error("bubblewrap node runtime overlaps a deny path");
    }
    await appendReadonlyRoot(nodeDir, nodeDir, denyPaths, context, false);
  }

  // 用户授权共享的凭证路径:在 HOME 投影之上叠一层可写 bind。
  // bwrap 按顺序执行,后来的 --bind 盖住投影里的只读副本;--remount-ro 非递归,
  // 不会把这层子挂载改回只读,于是 CLI 能像在终端里一样刷新 token / 写锁文件。
  for (const credential of policy.allowPaths.filter((path) => path.kind === "credential")) {
    if (!credential.exists) continue;
    context.args.push("--bind", credential.canonicalPath, credential.lexicalPath);
  }

  // 青简安装目录等可写例外:在 HOME 只读投影之上叠一层可写 bind。
  for (const writable of policy.allowPaths.filter(
    (path) => path.writable && path.kind !== "credential" && path.kind !== "session",
  )) {
    if (!writable.exists) continue;
    if (allowInsideData(writable, policy.dataDenyPath)) continue;
    context.args.push("--bind", writable.canonicalPath, writable.lexicalPath);
  }

  // 外部 agent 技能目录在所有可写覆盖之后再叠只读 bind；最宽档也不能改写。
  for (const readOnlySkill of policy.allowPaths.filter(
    (path) => path.kind === "user-skills" && !path.writable && path.exists,
  )) {
    context.args.push("--ro-bind", readOnlySkill.canonicalPath, readOnlySkill.lexicalPath);
  }

  const session = policy.allowPaths.find((path) => path.kind === "session");
  if (!session) throw new Error("bubblewrap policy is missing the session exception");
  if (!allowInsideData(session, policy.dataDenyPath)) {
    context.args.push("--bind", session.canonicalPath, session.lexicalPath);
  }
  // 所有投影 mountpoint/例外都创建完后再只读重挂祖先；--remount-ro 非递归，
  // 因而不会把明确重开的 session 子挂载改成只读。
  for (const destination of [...context.remountReadOnly].sort((left, right) => right.length - left.length)) {
    context.args.push("--remount-ro", destination);
  }
  context.args.push("--chdir", session.lexicalPath, "--die-with-parent");
  if (context.args.includes("--")) throw new Error("bubblewrap custom args must not contain the command terminator");

  const hash = createHash("sha256").update(JSON.stringify(context.args)).digest("hex");
  return {
    args: context.args,
    safeHomeBindings: context.safeBindings.filter((path) => readWallPathIsInside(path, policy.effectiveHome)),
    mode: "read-wall",
    hash,
  };
}

function fallbackAllowed(policy: ReadWallResolvedPolicy): boolean {
  const denyPaths = [...policy.credentialDenyPaths, policy.dataDenyPath];
  return policy.allowPaths.every((allowed) =>
    denyPaths.every((denied) => {
      if (allowInsideData(allowed, policy.dataDenyPath)) return true;
      return !variants(denied).some((denyPath) =>
        variants(allowed).some((allowedPath) => readWallPathIsInside(denyPath, allowedPath)),
      );
    }),
  );
}

export async function buildStrictFallbackBwrapArgs(
  policy: ReadWallResolvedPolicy,
  nodeExecutable: string,
): Promise<BuiltBubblewrapPolicy> {
  if (!fallbackAllowed(policy)) throw new Error("strict bwrap fallback would reopen a deny descendant");
  const args = [
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  const denyPaths = [...policy.credentialDenyPaths, policy.dataDenyPath];
  const fallbackRoots = [...SYSTEM_READONLY_BINDS, "/opt", "/snap"];
  if (denyPaths.some((denied) =>
    variants(denied).some((denyPath) => fallbackRoots.some((root) => readWallPathIsInside(denyPath, root))),
  )) {
    throw new Error("strict bwrap fallback system mounts would reopen a deny path");
  }
  for (const path of SYSTEM_READONLY_BINDS) args.push("--ro-bind-try", path, path);
  const nodeDir = dirname(await realpath(nodeExecutable));
  const nodeRule: ResolvedReadWallPath = {
    path: nodeDir,
    lexicalPath: nodeDir,
    canonicalPath: nodeDir,
    type: "directory",
  };
  if (denyPaths.some((denied) => readWallPathsOverlap(nodeRule, denied))) {
    throw new Error("strict bwrap fallback node runtime overlaps a deny path");
  }
  if (!SYSTEM_READONLY_BINDS.some((path) => readWallPathIsInside(nodeDir, path))) {
    args.push("--ro-bind", nodeDir, nodeDir);
  }
  args.push("--ro-bind-try", "/opt", "/opt", "--ro-bind-try", "/snap", "/snap");
  for (const allowed of policy.allowPaths.filter(
    (path) => !path.writable && path.exists && path.kind !== "credential",
  )) {
    args.push("--ro-bind", allowed.canonicalPath, allowed.lexicalPath);
  }
  for (const credential of policy.allowPaths.filter((path) => path.kind === "credential" && path.exists)) {
    args.push("--bind", credential.canonicalPath, credential.lexicalPath);
  }
  for (const writable of policy.allowPaths.filter(
    (path) => path.writable && path.exists && path.kind !== "credential" && path.kind !== "session",
  )) {
    args.push("--bind", writable.canonicalPath, writable.lexicalPath);
  }
  const session = policy.allowPaths.find((path) => path.kind === "session");
  if (!session) throw new Error("strict bwrap fallback is missing the session exception");
  args.push("--bind", session.canonicalPath, session.lexicalPath);
  args.push("--chdir", session.lexicalPath, "--die-with-parent");
  return {
    args,
    safeHomeBindings: [],
    mode: "strict-fallback",
    hash: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
  };
}

async function probeBubblewrapPolicy(
  built: BuiltBubblewrapPolicy,
  policy: ReadWallResolvedPolicy,
  env: NodeJS.ProcessEnv,
  runner: ReadWallProcessRunner,
): Promise<void> {
  const session = policy.allowPaths.find((path) => path.kind === "session");
  const skills = policy.allowPaths.find((path) => path.kind === "builtin-skills" && path.exists);
  if (!session) throw new Error("bubblewrap preflight is missing the session exception");
  const suffix = `${built.hash.slice(0, 12)}-${randomBytes(6).toString("hex")}`;
  const deniedProbe = join(policy.dataDenyPath.lexicalPath, `.read-wall-denied-${suffix}`);
  const sessionProbe = join(session.lexicalPath, `.read-wall-write-${suffix}`);
  const symlinkProbe = join(session.lexicalPath, `.read-wall-link-${suffix}`);
  const skillsProbe = skills ? join(skills.lexicalPath, `.read-wall-write-${suffix}`) : null;
  await mkdir(policy.dataDenyPath.lexicalPath, { recursive: true });
  await writeFile(deniedProbe, "qingagent-denied-probe", { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rm(symlinkProbe, { force: true });
  await symlink(deniedProbe, symlinkProbe);
  const checks = [
    `if cat ${shellQuoteReadWallPath(deniedProbe)}; then exit 51; fi`,
    `if cat ${shellQuoteReadWallPath(symlinkProbe)}; then exit 52; fi`,
    `printf qingagent-read-wall > ${shellQuoteReadWallPath(sessionProbe)}`,
    `test "$(cat ${shellQuoteReadWallPath(sessionProbe)})" = qingagent-read-wall`,
    `rm -f ${shellQuoteReadWallPath(sessionProbe)}`,
    "test -r /proc/self/status",
    // /dev 缺失会让 `2>/dev/null` 这类最常见写法直接失败,预检必须覆盖。
    "test -w /dev/null && test -r /dev/urandom",
    "printf probe 2>/dev/null >/dev/null",
    "node -e 'process.stdout.write(\"node-ok\")'",
  ];
  if (built.mode === "read-wall" && built.safeHomeBindings[0]) {
    checks.push(`test -r ${shellQuoteReadWallPath(built.safeHomeBindings[0])}`);
  }
  if (skills) checks.push(`test -r ${shellQuoteReadWallPath(skills.lexicalPath)}`);
  if (skillsProbe) checks.push(`if printf nope > ${shellQuoteReadWallPath(skillsProbe)}; then exit 53; fi`);
  let result: ReadWallProcessResult;
  try {
    result = await runner("bwrap", [...built.args, "--", "sh", "-c", checks.join(" && ")], {
      env,
      timeoutMs: 20_000,
      cwd: session.lexicalPath,
    });
  } finally {
    await Promise.all([
      rm(deniedProbe, { force: true }),
      rm(sessionProbe, { force: true }),
      rm(symlinkProbe, { force: true }),
      ...(skillsProbe ? [rm(skillsProbe, { force: true })] : []),
    ]).catch(() => undefined);
  }
  if (result.exitCode !== 0) throw new Error(`bubblewrap ${built.mode} behavior preflight failed`);
}

export async function prepareBubblewrapReadWallPolicy(
  options: PrepareBubblewrapPolicyOptions,
): Promise<BuiltBubblewrapPolicy> {
  const runner = options.runner ?? runReadWallProcess;
  const version = await runner("bwrap", ["--version"], { env: options.env, timeoutMs: 5_000 });
  if (version.exitCode !== 0) throw new Error("bubblewrap is unavailable");

  try {
    const readWall = await buildBubblewrapReadWallArgs(options.policy, options.nodeExecutable);
    await probeBubblewrapPolicy(readWall, options.policy, options.env, runner);
    return readWall;
  } catch (readWallError) {
    const fallback = await buildStrictFallbackBwrapArgs(options.policy, options.nodeExecutable);
    try {
      await probeBubblewrapPolicy(fallback, options.policy, options.env, runner);
      return fallback;
    } catch {
      throw readWallError;
    }
  }
}

export function validateBubblewrapArgsContract(args: string[], requireUserNamespace: boolean): void {
  const requiredFlags = [
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--proc",
    "--dev",
    "--tmpfs",
    "--chdir",
    "--die-with-parent",
  ];
  if (requireUserNamespace) requiredFlags.push("--unshare-user");
  for (const flag of requiredFlags) {
    if (!args.includes(flag)) throw new Error(`bubblewrap args are missing ${flag}`);
  }
  if (args.includes("--")) throw new Error("bubblewrap args must not include Mastra's command terminator");
  // 有意设计:读写墙是文件边界不是网络边界,沙箱命令保持可出网(装依赖/抓资料)。
  if (args.includes("--unshare-net")) throw new Error("bubblewrap read wall must preserve network access");
}
