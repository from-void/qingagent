import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const READ_WALL_POLICY_VERSION = "v1";

export type ReadWallPathType = "directory" | "file";
export type ReadWallPlatform = "linux" | "darwin";

export interface ReadWallPath {
  path: string;
  type: ReadWallPathType;
}

export interface ResolvedReadWallPath extends ReadWallPath {
  lexicalPath: string;
  canonicalPath: string;
}

export type ReadWallAllowKind =
  | "session"
  | "bin"
  | "builtin-skills"
  | "user-skills"
  | "extra"
  /** 技能声明 + 用户授权的凭证路径:读放行且可写,让 CLI 与终端共享同一份登录态。 */
  | "credential";

/**
 * 凭证墙档位。standard = 产品默认(黑名单照旧,只按授权开口子);
 * wide = 最宽档(YOLO):凭证类黑名单整体豁免、写墙放开到 HOME,
 * 但"浏览器数据/系统钥匙串"永远 deny,不随档位豁免。
 */
export type CredentialWallMode = "standard" | "wide";

export interface ResolvedReadWallAllowPath extends ResolvedReadWallPath {
  kind: ReadWallAllowKind;
  writable: boolean;
  exists: boolean;
}

export interface ReadWallResolvedPolicy {
  version: typeof READ_WALL_POLICY_VERSION;
  platform: ReadWallPlatform;
  effectiveUid: number;
  effectiveHome: string;
  credentialDenyPaths: ResolvedReadWallPath[];
  dataDenyPath: ResolvedReadWallPath;
  allowPaths: ResolvedReadWallAllowPath[];
  credentialWallMode: CredentialWallMode;
  /** wide 档下整个 HOME 可写(等价 codex danger 语义);standard 档恒为 false。 */
  writableHome: boolean;
  warnings: string[];
  hash: string;
}

export interface ResolveReadWallPolicyOptions {
  platform: ReadWallPlatform;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  sessionDir: string;
  sandboxBinDir: string;
  builtinSkillsDir: string;
  userSkillsDir: string;
  extraReadOnlyPaths: string[];
  /** 已授权的凭证路径(绝对路径,由技能声明 + 用户授权得出)。 */
  grantedCredentialPaths?: string[];
  credentialWallMode?: CredentialWallMode;
  effectiveUid?: number;
  effectiveHome?: string;
}

interface RawDenyPath extends ReadWallPath {
  home: string;
  /**
   * hard = 浏览器数据 / 系统钥匙串 / 部署方追加的 deny:授权不放行、YOLO 也不豁免。
   * 非 hard = 凭证类黑名单:可被"技能声明 + 用户授权"开口子,YOLO 档整体豁免。
   */
  hard: boolean;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathsOverlap(left: ResolvedReadWallPath, right: ResolvedReadWallPath): boolean {
  const leftPaths = [left.lexicalPath, left.canonicalPath];
  const rightPaths = [right.lexicalPath, right.canonicalPath];
  return leftPaths.some((leftPath) =>
    rightPaths.some((rightPath) => isPathInside(leftPath, rightPath) || isPathInside(rightPath, leftPath)),
  );
}

function pathFallsInside(candidate: ResolvedReadWallPath, parent: ResolvedReadWallPath): boolean {
  return [candidate.lexicalPath, candidate.canonicalPath].some((candidatePath) =>
    [parent.lexicalPath, parent.canonicalPath].some((parentPath) => isPathInside(candidatePath, parentPath)),
  );
}

function validatePathText(rawPath: string): void {
  if (!rawPath || CONTROL_CHARACTER.test(rawPath)) {
    throw new Error("read-wall path contains an empty value or control character");
  }
  if (rawPath.startsWith("~") && rawPath !== "~" && !rawPath.startsWith(`~${sep}`)) {
    throw new Error("read-wall only supports a leading ~/ home expansion");
  }
}

function expandPolicyPath(rawPath: string, home: string): string {
  validatePathText(rawPath);
  if (rawPath === "~") throw new Error("read-wall only supports a leading ~/ home expansion");
  if (rawPath.startsWith(`~${sep}`)) return resolve(home, rawPath.slice(2));
  if (!isAbsolute(rawPath)) {
    throw new Error("read-wall paths must be absolute or start with ~/");
  }
  return resolve(rawPath);
}

async function canonicalizeWithMissingTail(lexicalPath: string): Promise<string> {
  let cursor = lexicalPath;
  const missingTail: string[] = [];
  while (true) {
    try {
      const canonicalAncestor = await realpath(cursor);
      return resolve(canonicalAncestor, ...missingTail.reverse());
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "ENOTDIR") {
        throw new Error("read-wall path has a non-directory ancestor");
      }
      if (code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new Error("read-wall cannot find an existing ancestor for a path");
      }
      missingTail.push(basename(cursor));
      cursor = parent;
    }
  }
}

export async function resolveReadWallPath(
  rawPath: string,
  type: ReadWallPathType,
  home: string,
): Promise<ResolvedReadWallPath> {
  const lexicalPath = expandPolicyPath(rawPath, home);
  const canonicalPath = await canonicalizeWithMissingTail(lexicalPath);
  return { path: lexicalPath, lexicalPath, canonicalPath, type };
}

function addHomeDenyPaths(target: RawDenyPath[], home: string, configHome: string): void {
  const add = (path: string, type: ReadWallPathType): void => {
    target.push({ path, type, home, hard: false });
  };
  add(join(home, ".ssh"), "directory");
  add(join(home, ".aws"), "directory");
  add(join(home, ".gnupg"), "directory");
  add(join(home, ".kube"), "directory");
  // .lark-cli 与 .aws/.ssh 同属凭证类默认 deny(非 hard),它的放行已完全交给
  // 「feishu 技能声明 credential-paths + 用户授权」这条通道,代码里不再有任何
  // 针对 lark-cli 的特判。这一行留着是"未授权即读拒"的来源——删掉会把
  // ~/.lark-cli 直接降级成沙箱内可读,与方案第 2/3 节"授权前读拒"自相矛盾。
  add(join(home, ".lark-cli"), "directory");
  add(join(configHome, "gcloud"), "directory");
  add(join(home, ".config", "gcloud"), "directory");
  add(join(home, ".azure"), "directory");
  add(join(configHome, "gh"), "directory");
  add(join(home, ".netrc"), "file");
  add(join(home, ".npmrc"), "file");
  add(join(home, ".git-credentials"), "file");
  add(join(home, ".pypirc"), "file");
  add(join(home, ".terraform.d", "credentials.tfrc.json"), "file");
  add(join(home, ".docker", "config.json"), "file");
  add(join(home, ".docker", "contexts"), "directory");
  add(join(home, ".docker", "run"), "directory");
}

function addLinuxDenyPaths(target: RawDenyPath[], home: string, configHome: string): void {
  const add = (path: string, type: ReadWallPathType = "directory"): void => {
    target.push({ path, type, home, hard: true });
  };
  add(join(home, ".local", "share", "keyrings"));
  add(join(home, ".local", "share", "kwalletd"));
  add(join(configHome, "google-chrome"));
  add(join(configHome, "chromium"));
  add(join(configHome, "microsoft-edge"));
  add(join(configHome, "BraveSoftware", "Brave-Browser"));
  add(join(home, ".mozilla", "firefox"));
  add(join(configHome, "mozilla", "firefox"));
  add(join(home, ".var", "app", "com.google.Chrome", "config", "google-chrome"));
  add(join(home, ".var", "app", "org.chromium.Chromium", "config", "chromium"));
  add(join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"));
  add(join(home, ".var", "app", "com.microsoft.Edge", "config", "microsoft-edge"));
}

function addMacDenyPaths(target: RawDenyPath[], home: string): void {
  const add = (path: string): void => {
    target.push({ path, type: "directory", home, hard: true });
  };
  add(join(home, "Library", "Application Support", "Google", "Chrome"));
  add(join(home, "Library", "Application Support", "Chromium"));
  add(join(home, "Library", "Application Support", "Microsoft Edge"));
  add(join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"));
  add(join(home, "Library", "Application Support", "Firefox"));
  add(join(home, "Library", "Safari"));
  add(join(home, "Library", "Containers", "com.apple.Safari"));
  add(join(home, "Library", "Group Containers", "group.com.apple.Safari"));
  add(join(home, "Library", "Cookies"));
  add(join(home, "Library", "Keychains"));
  add("/Library/Keychains");
}

function parseAbsoluteEnvPath(value: string, home: string, variable: string): string {
  try {
    return expandPolicyPath(value, home);
  } catch {
    throw new Error(`read-wall ${variable} must be an absolute path or start with ~/`);
  }
}

function addCustomEnvironmentDenyPaths(
  target: RawDenyPath[],
  env: NodeJS.ProcessEnv,
  effectiveHome: string,
): void {
  const addEnv = (variable: string, type: ReadWallPathType): void => {
    const value = env[variable]?.trim();
    if (!value) return;
    target.push({
      path: parseAbsoluteEnvPath(value, effectiveHome, variable),
      type,
      home: effectiveHome,
      hard: false,
    });
  };
  addEnv("AWS_SHARED_CREDENTIALS_FILE", "file");
  addEnv("AWS_CONFIG_FILE", "file");
  addEnv("CLOUDSDK_CONFIG", "directory");
  addEnv("NPM_CONFIG_USERCONFIG", "file");
  addEnv("DOCKER_CONFIG", "directory");

  const kubeconfig = env.KUBECONFIG;
  if (kubeconfig) {
    for (const entry of kubeconfig.split(delimiter)) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      target.push({
        path: parseAbsoluteEnvPath(trimmed, effectiveHome, "KUBECONFIG"),
        type: "file",
        home: effectiveHome,
        hard: false,
      });
    }
  }
}

function addAppendOnlyDenyPaths(
  target: RawDenyPath[],
  rawJson: string | undefined,
  effectiveHome: string,
): void {
  if (!rawJson?.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("read-wall extra deny JSON is invalid");
  }
  if (!Array.isArray(parsed)) throw new Error("read-wall extra deny JSON must be an array");
  for (const entry of parsed) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { path?: unknown }).path !== "string" ||
      ((entry as { type?: unknown }).type !== "directory" && (entry as { type?: unknown }).type !== "file")
    ) {
      throw new Error("read-wall extra deny entries require path and directory/file type");
    }
    const path = parseAbsoluteEnvPath((entry as { path: string }).path, effectiveHome, "extra deny path");
    // 部署方追加的 deny 是逃生阀,不可被用户授权反向打开。
    target.push({
      path,
      type: (entry as { type: ReadWallPathType }).type,
      home: effectiveHome,
      hard: true,
    });
  }
}

function compressDenyPaths(paths: ResolvedReadWallPath[]): ResolvedReadWallPath[] {
  const deduped = new Map<string, ResolvedReadWallPath>();
  for (const path of paths) {
    const key = `${path.type}\0${path.lexicalPath}\0${path.canonicalPath}`;
    deduped.set(key, path);
  }
  const sorted = [...deduped.values()].sort((left, right) => {
    const lengthDiff = left.lexicalPath.length - right.lexicalPath.length;
    return lengthDiff || left.lexicalPath.localeCompare(right.lexicalPath);
  });
  return sorted.filter((candidate, index) =>
    !sorted.some((parent, parentIndex) => {
      if (parentIndex === index || parent.type !== "directory") return false;
      return (
        isPathInside(candidate.lexicalPath, parent.lexicalPath) &&
        isPathInside(candidate.canonicalPath, parent.canonicalPath)
      );
    }),
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function validateResolvedPathType(path: ResolvedReadWallPath): Promise<void> {
  if (!(await pathExists(path.lexicalPath))) return;
  const info = await stat(path.canonicalPath);
  if (path.type === "directory" ? !info.isDirectory() : !info.isFile()) {
    throw new Error("read-wall existing path does not match its declared file/directory type");
  }
}

async function validatePathAncestors(path: string, boundary: string, effectiveUid: number): Promise<void> {
  if (!isPathInside(path, boundary)) throw new Error("read-wall ancestor validation escaped its trust boundary");
  const relativePath = relative(boundary, path);
  const components = relativePath ? relativePath.split(sep).filter(Boolean) : [];
  let cursor = boundary;
  const paths = [cursor];
  for (const component of components) {
    cursor = join(cursor, component);
    paths.push(cursor);
  }
  for (const candidate of paths) {
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    if (info.uid !== 0 && info.uid !== effectiveUid) {
      throw new Error("read-wall path has an ancestor owned by an unexpected UID");
    }
  }
}

async function validateAllowedPathOwnership(
  path: ResolvedReadWallAllowPath,
  effectiveUid: number,
  effectiveHome: string,
  dataPath: ResolvedReadWallPath,
): Promise<void> {
  if (!path.exists) return;
  const info = await stat(path.canonicalPath);
  // 凭证例外允许是单个文件(~/.netrc 形态);其余例外仍必须是目录。
  const typeOk = path.kind === "credential"
    ? (path.type === "file" ? info.isFile() : info.isDirectory())
    : info.isDirectory();
  if (!typeOk) throw new Error("read-wall allow exception has an unexpected file type");
  const writableTarget = path.writable || path.kind === "bin";
  if (writableTarget && info.uid !== effectiveUid) {
    throw new Error("read-wall writable exception is not owned by the effective UID");
  }
  if (!writableTarget && info.uid !== effectiveUid && info.uid !== 0) {
    throw new Error("read-wall read-only exception has an unexpected owner");
  }
  const boundary = isPathInside(path.lexicalPath, dataPath.lexicalPath)
    ? dataPath.lexicalPath
    : isPathInside(path.lexicalPath, effectiveHome)
      ? effectiveHome
      : path.lexicalPath;
  await validatePathAncestors(path.lexicalPath, boundary, effectiveUid);
}

async function resolveAllowPath(
  path: string,
  kind: ReadWallAllowKind,
  writable: boolean,
  home: string,
): Promise<ResolvedReadWallAllowPath> {
  const resolved = await resolveReadWallPath(path, "directory", home);
  return { ...resolved, kind, writable, exists: await pathExists(resolved.lexicalPath) };
}

/**
 * 凭证例外可以是目录也可以是单个文件(如 ~/.netrc 形态的凭证文件),
 * 因此类型按磁盘实况判定;尚不存在时按目录处理,由调用方先行创建。
 */
async function resolveCredentialAllowPath(
  path: string,
  home: string,
): Promise<ResolvedReadWallAllowPath> {
  const lexicalPath = expandPolicyPath(path, home);
  const canonicalPath = await canonicalizeWithMissingTail(lexicalPath);
  let type: ReadWallPathType = "directory";
  let exists = false;
  try {
    const info = await lstat(lexicalPath);
    exists = true;
    type = info.isDirectory() ? "directory" : "file";
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  return {
    path: lexicalPath,
    lexicalPath,
    canonicalPath,
    type,
    kind: "credential",
    writable: true,
    exists,
  };
}

function assertNoCredentialExceptionConflicts(
  allowPaths: ResolvedReadWallAllowPath[],
  credentialDenyPaths: ResolvedReadWallPath[],
): void {
  // kind=credential 就是"用户明确授权放行的凭证路径",与 deny 相交是它存在的意义;
  // 相交是否安全已在 selectGrantedCredentialPaths 里按 hard/非 hard 判过。
  for (const allowed of allowPaths.filter((path) => path.kind !== "credential")) {
    for (const denied of credentialDenyPaths) {
      if (pathFallsInside(allowed, denied)) {
        throw new Error("read-wall allow path overlaps a credential deny path");
      }
    }
  }
}

interface GrantedCredentialSelection {
  granted: ResolvedReadWallAllowPath[];
  warnings: string[];
}

/**
 * 从"已授权路径"里筛出真正可以生效的:
 * - 落在 hard deny(浏览器数据 / 钥匙串 / 部署方追加)之内或之外包住它的,一律丢弃;
 * - 其余保留,并把被它覆盖的凭证类 deny 从读墙里摘掉。
 * 丢弃只记 warning 不抛错:一条声明写歪不该让整个会话失去命令能力。
 */
function selectGrantedCredentialPaths(
  granted: ResolvedReadWallAllowPath[],
  hardDenyPaths: ResolvedReadWallPath[],
  effectiveHome: string,
): GrantedCredentialSelection {
  const kept: ResolvedReadWallAllowPath[] = [];
  const warnings: string[] = [];
  for (const candidate of granted) {
    if (!isPathInside(candidate.lexicalPath, effectiveHome)
      || !isPathInside(candidate.canonicalPath, effectiveHome)
      || candidate.lexicalPath === effectiveHome) {
      warnings.push("CREDENTIAL_GRANT_OUTSIDE_HOME");
      continue;
    }
    if (hardDenyPaths.some((denied) => pathsOverlap(candidate, denied))) {
      warnings.push("CREDENTIAL_GRANT_HITS_PERMANENT_DENY");
      continue;
    }
    kept.push(candidate);
  }
  return { granted: kept, warnings };
}

/** 凭证类 deny 中被已授权路径覆盖的条目直接摘除;hard deny 永远保留。 */
function applyCredentialGrantsToDeny(
  denyPaths: { resolved: ResolvedReadWallPath; hard: boolean }[],
  granted: ResolvedReadWallAllowPath[],
): ResolvedReadWallPath[] {
  return denyPaths
    .filter((entry) =>
      entry.hard || !granted.some((allowed) => pathsOverlap(entry.resolved, allowed)),
    )
    .map((entry) => entry.resolved);
}

function assertDataExceptionRules(
  allowPaths: ResolvedReadWallAllowPath[],
  dataDenyPath: ResolvedReadWallPath,
): void {
  const fixedExceptions = new Set<ReadWallAllowKind>(["session", "bin", "builtin-skills", "user-skills"]);
  // 凭证例外恒在 HOME 下,不可能落进数据目录;真落进去说明配置串了,照旧按下面的规则拒。
  for (const allowed of allowPaths) {
    if (pathFallsInside(allowed, dataDenyPath) && !fixedExceptions.has(allowed.kind)) {
      throw new Error("read-wall data directory may only reopen session, bin, or skills");
    }
  }
  const session = allowPaths.find((path) => path.kind === "session");
  const bin = allowPaths.find((path) => path.kind === "bin");
  if (!session || !bin || !pathFallsInside(session, dataDenyPath) || !pathFallsInside(bin, dataDenyPath)) {
    throw new Error("read-wall session and bin must be canonically contained by the data directory");
  }
}

function policyHash(input: Omit<ReadWallResolvedPolicy, "hash">): string {
  const serializable = {
    version: input.version,
    platform: input.platform,
    effectiveUid: input.effectiveUid,
    effectiveHome: input.effectiveHome,
    credentialDenyPaths: input.credentialDenyPaths.map((path) => [path.type, path.lexicalPath, path.canonicalPath]),
    dataDenyPath: [input.dataDenyPath.lexicalPath, input.dataDenyPath.canonicalPath],
    allowPaths: input.allowPaths.map((path) => [
      path.kind,
      path.writable,
      path.lexicalPath,
      path.canonicalPath,
      path.exists,
      path.type,
    ]),
    credentialWallMode: input.credentialWallMode,
    writableHome: input.writableHome,
  };
  return createHash("sha256").update(JSON.stringify(serializable)).digest("hex");
}

export async function resolveReadWallPolicy(
  options: ResolveReadWallPolicyOptions,
): Promise<ReadWallResolvedPolicy> {
  const effectiveUid = options.effectiveUid ?? (typeof process.geteuid === "function" ? process.geteuid() : -1);
  const effectiveHome = resolve(options.effectiveHome ?? userInfo().homedir);
  const effectiveHomeInfo = await stat(await realpath(effectiveHome));
  if (!effectiveHomeInfo.isDirectory() || effectiveHomeInfo.uid !== effectiveUid) {
    throw new Error("read-wall effective UID home is missing, not a directory, or not owned by the effective UID");
  }
  const warnings: string[] = [];
  const declaredHome = options.env.HOME?.trim();
  const homes = new Set([effectiveHome]);
  if (declaredHome) {
    const normalizedDeclaredHome = expandPolicyPath(declaredHome, effectiveHome);
    if (normalizedDeclaredHome !== effectiveHome) {
      homes.add(normalizedDeclaredHome);
      warnings.push("HOME_MISMATCH_EFFECTIVE_UID");
    }
  }

  const xdgConfig = options.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfig && !isAbsolute(xdgConfig)) {
    throw new Error("read-wall XDG_CONFIG_HOME must be absolute");
  }

  const rawDenyPaths: RawDenyPath[] = [];
  for (const home of homes) {
    const configHome = xdgConfig ? resolve(xdgConfig) : join(home, ".config");
    addHomeDenyPaths(rawDenyPaths, home, configHome);
    if (options.platform === "linux") addLinuxDenyPaths(rawDenyPaths, home, configHome);
    else addMacDenyPaths(rawDenyPaths, home);
  }
  addCustomEnvironmentDenyPaths(rawDenyPaths, options.env, effectiveHome);
  addAppendOnlyDenyPaths(
    rawDenyPaths,
    options.env.QINGAGENT_SANDBOX_EXTRA_DENY_PATHS_JSON,
    effectiveHome,
  );

  const credentialWallMode: CredentialWallMode = options.credentialWallMode ?? "standard";
  // 最宽档:凭证类黑名单整体豁免,只留浏览器数据/钥匙串这类永久 deny。
  const effectiveRawDenyPaths = credentialWallMode === "wide"
    ? rawDenyPaths.filter((entry) => entry.hard)
    : rawDenyPaths;
  const resolvedDenyPaths = await Promise.all(
    effectiveRawDenyPaths.map(async (entry) => ({
      resolved: await resolveReadWallPath(entry.path, entry.type, entry.home),
      hard: entry.hard,
    })),
  );
  const hardDenyPaths = resolvedDenyPaths
    .filter((entry) => entry.hard)
    .map((entry) => entry.resolved);

  const requestedCredentialPaths = await Promise.all(
    (options.grantedCredentialPaths ?? []).map((path) =>
      resolveCredentialAllowPath(path, effectiveHome),
    ),
  );
  const credentialSelection = selectGrantedCredentialPaths(
    requestedCredentialPaths,
    hardDenyPaths,
    effectiveHome,
  );
  warnings.push(...credentialSelection.warnings);

  const credentialDenyPaths = compressDenyPaths(
    applyCredentialGrantsToDeny(resolvedDenyPaths, credentialSelection.granted),
  );
  const dataDenyPath = await resolveReadWallPath(options.dataDir, "directory", effectiveHome);
  const allowPaths = await Promise.all([
    resolveAllowPath(options.sessionDir, "session", true, effectiveHome),
    resolveAllowPath(options.sandboxBinDir, "bin", false, effectiveHome),
    resolveAllowPath(options.builtinSkillsDir, "builtin-skills", false, effectiveHome),
    resolveAllowPath(options.userSkillsDir, "user-skills", false, effectiveHome),
    ...options.extraReadOnlyPaths.map((path) => resolveAllowPath(path, "extra", false, effectiveHome)),
  ]);
  allowPaths.push(...credentialSelection.granted);

  assertNoCredentialExceptionConflicts(allowPaths, credentialDenyPaths);
  assertDataExceptionRules(allowPaths, dataDenyPath);
  for (const denied of credentialDenyPaths) await validateResolvedPathType(denied);
  await validateResolvedPathType(dataDenyPath);
  if (await pathExists(dataDenyPath.lexicalPath)) {
    const dataInfo = await stat(dataDenyPath.canonicalPath);
    if (dataInfo.uid !== effectiveUid) throw new Error("read-wall data directory is not owned by the effective UID");
    const boundary = isPathInside(dataDenyPath.lexicalPath, effectiveHome)
      ? effectiveHome
      : dataDenyPath.lexicalPath;
    await validatePathAncestors(dataDenyPath.lexicalPath, boundary, effectiveUid);
  }
  for (const allowed of allowPaths) {
    await validateAllowedPathOwnership(allowed, effectiveUid, effectiveHome, dataDenyPath);
  }

  const withoutHash: Omit<ReadWallResolvedPolicy, "hash"> = {
    version: READ_WALL_POLICY_VERSION,
    platform: options.platform,
    effectiveUid,
    effectiveHome,
    credentialDenyPaths,
    dataDenyPath,
    allowPaths,
    credentialWallMode,
    writableHome: credentialWallMode === "wide",
    warnings,
  };
  return { ...withoutHash, hash: policyHash(withoutHash) };
}

export function readWallPathIsInside(child: string, parent: string): boolean {
  return isPathInside(child, parent);
}

export function readWallPathsOverlap(left: ResolvedReadWallPath, right: ResolvedReadWallPath): boolean {
  return pathsOverlap(left, right);
}

export async function listDirectorySorted(path: string): Promise<string[]> {
  return (await readdir(path)).sort((left, right) => left.localeCompare(right));
}
