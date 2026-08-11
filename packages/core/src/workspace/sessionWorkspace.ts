// 会话级 Workspace + LocalSandbox:沙箱能力的核心装配。
//
// 设计(.tmp/sbx-analysis/design.md):
// - 每个会话(=每篇文档)一个 Workspace:私有读写目录 + 技能目录只读共享;
//   命令执行(execute_command)工作目录锁定在会话目录,会话间互不可见。
// - 隔离后端按平台自适应:Linux→bwrap(已安装才用)/macOS→seatbelt/Windows→none。
//   none 时仍有 workingDirectory+超时兜底；仅「不再询问」档按用户本人环境执行，
//   非 bypass 的显式未隔离部署仍维持最小 env。
// - 三端共用:desktop(Electron)嵌的是同一个 Hono server,本模块一处生效。
// - 失败兜底:任何装配异常回退到全局技能 Workspace(qingagentWorkspace),
//   保证沙箱永远不把主链拖死。

import {
  CompositeFilesystem,
  LocalFilesystem,
  LocalSandbox,
  LocalSkillSource,
  WORKSPACE_TOOLS,
  Workspace,
  type CopyOptions,
  type FileContent,
  type FileEntry,
  type FileStat,
  type FilesystemInfo,
  type ListOptions,
  type ReadOptions,
  type RemoveOptions,
  type WriteOptions,
  type WorkspaceFilesystem,
} from "@mastra/core/workspace";
import type { FolderSourceRecord } from "@qingagent/contract-ts";
import { listCredentialGrants } from "@qingagent/db";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, realpath, rm } from "node:fs/promises";
import { delimiter, isAbsolute, join, posix, relative, resolve } from "node:path";
import {
  getSessionFolderSources,
  browserFolderSourcesEnabled,
  localFolderSourcesEnabled,
  normalizeFolderSourceRecord,
  normalizeFolderSourceRecords,
} from "../folderSources/runtime.js";
import { isBypassEnabled, loadBypassMode } from "../security/bypassMode.js";
import { BrowserBridgeFilesystem } from "./browserBridgeFilesystem.js";
import {
  BUILTIN_SKILLS_DIR,
  USER_SKILLS_DIR,
  USER_SKILL_SOURCE_DIRS,
} from "../skills/paths.js";
import {
  ensureCredentialPathExists,
  listCredentialRequests,
  selectEffectiveCredentialPaths,
  type CredentialGrantRef,
} from "../skills/credentialRequests.js";
import {
  prepareReadWall,
  ReadWallLocalSandbox,
  type PreparedReadWall,
} from "./readWallSandbox.js";
import type { CredentialWallMode } from "./readWallPolicy.js";
import {
  QINGAGENT_DATA_DIR,
  SANDBOX_BIN_DIR,
  SANDBOX_NODE_RUNTIME_DIR,
  SANDBOX_SESSIONS_BASE,
} from "./sandboxPaths.js";
export {
  QINGAGENT_DATA_DIR,
  SANDBOX_BIN_DIR,
  SANDBOX_NODE_RUNTIME_DIR,
  SANDBOX_SESSIONS_BASE,
} from "./sandboxPaths.js";

/** 单命令默认超时(ms),运维可调。 */
function positiveNumberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const SANDBOX_TIMEOUT_MS = positiveNumberEnv(process.env.QINGAGENT_SANDBOX_TIMEOUT_MS, 120_000);

export type ResolvedIsolation = "none" | "seatbelt" | "bwrap";

let cachedIsolation: ResolvedIsolation | null = null;

/** 隔离后端解析:env 显式指定 > 平台自动探测(不可用回退 none)。结果进程级缓存。 */
export function resolveIsolation(): ResolvedIsolation {
  if (cachedIsolation) return cachedIsolation;
  const forced = process.env.QINGAGENT_SANDBOX_ISOLATION;
  if (forced === "none" || forced === "seatbelt" || forced === "bwrap") {
    cachedIsolation = forced;
    return forced;
  }
  try {
    const detected = LocalSandbox.detectIsolation();
    cachedIsolation = detected.available ? detected.backend : "none";
  } catch {
    cachedIsolation = "none";
  }
  return cachedIsolation;
}

/** 仅测试用:重置探测缓存。 */
export function __resetIsolationCacheForTest(): void {
  cachedIsolation = null;
}

/**
 * 本次装配真正使用的隔离形态。
 *
 * 处于「不再询问」档时(260811 后也是缺省档),命令按无隔离装配、以用户本人身份
 * (含完整用户环境)直接执行——这正是这个开关存在的原因:隔离层与最小 env 都会挡住
 * 用户本机已有的登录态；CODEX_HOME 透传只修了一个路径指针个案，按档位选择 env 才是
 * 产品化根治。「每次询问」则是防御档，继续使用真隔离 + 最小 env。
 * resolveIsolation() 保持"平台探测"的纯粹语义,诊断面板等只关心宿主能力的调用方继续读它。
 */
export function resolveEffectiveIsolation(): ResolvedIsolation {
  return isBypassEnabled() ? "none" : resolveIsolation();
}

/** sessionId 进文件路径前统一哈希：固定长度、抗碰撞，且仅输出路径安全字符。 */
export function sessionWorkspaceDirName(sessionId: string): string {
  return `sid_${createHash("sha256").update(sessionId, "utf8").digest("hex")}`;
}

export function sessionWorkspaceDir(sessionId: string): string {
  return join(SANDBOX_SESSIONS_BASE, sessionWorkspaceDirName(sessionId));
}

/**
 * 沙箱内包管理器缓存目录。npm/npx 默认写 `~/.npm`,而写墙只放开会话目录与技能目录,
 * 于是 `npx -y <包>` 会被直接打死。把缓存重定向到产品数据目录下的共享位置:
 * 既不用给 HOME 开任何口子,又能跨会话复用下载(比塞进 session 目录更省网、更干净)。
 */
export const SANDBOX_PACKAGE_CACHE_DIR = join(QINGAGENT_DATA_DIR, "package-cache");

/** 让包管理器把缓存/临时产物写进沙箱可写区,而不是 HOME。 */
export function packageManagerCacheEnv(cacheDir = SANDBOX_PACKAGE_CACHE_DIR): NodeJS.ProcessEnv {
  return {
    npm_config_cache: cacheDir,
    NPM_CONFIG_CACHE: cacheDir,
    YARN_CACHE_FOLDER: join(cacheDir, "yarn"),
    npm_config_store_dir: join(cacheDir, "pnpm-store"),
    XDG_CACHE_HOME: cacheDir,
  };
}

// 沙箱必需的系统 env 白名单(命令解析/临时目录/可执行查找所需),按平台不同;
// 仅这些系统变量透传,业务密钥与宿主任意变量一律不带。
const SYSTEM_ENV_KEYS_POSIX = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];
const SYSTEM_ENV_KEYS_WIN = [
  "PATH", "Path", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP",
  "windir", "SystemDrive", "USERPROFILE", "NUMBER_OF_PROCESSORS",
];
// 用户 CLI 配置路径指针透传:「本机 Codex」路线需要继承用户自己的 codex 登录态。
// CODEX_HOME 只是配置目录指针、不是机密,不违背“沙箱 env 不带托管凭据”的初衷。
// 实证(260811 用户机):CODEX_HOME 指向自定义盘符时,未透传会导致沙箱内 codex 误报未登录。
const USER_CLI_ENV_KEYS = ["CODEX_HOME"];
// 代理变量透传:lark-cli 是 Go net/http 二进制,认 HTTP(S)_PROXY、尊重 NO_PROXY、不读 ALL_PROXY
// (实测:只设 ALL_PROXY=死端口仍直连成功=没走它,只设 HTTPS_PROXY=死端口才失败;旧注释"只认 ALL_PROXY"是反的)。
// ALL_PROXY 仍透传以兼容其它工具/老版本。需代理的网络环境靠这些变量出网。
// 有意设计:主动透传代理变量就是为了让沙箱命令更容易出网;命令层可联网是产品能力边界。
const PROXY_ENV_KEYS = [
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "all_proxy", "no_proxy",
];

// 飞书/Lark 官方域名后缀(从 lark-cli Go 二进制内置端点实测汇总):OAuth 设备授权 accounts.*、
// OpenAPI open.*、CDN/附件下载等全部子域,NO_PROXY 后缀写法即覆盖所有子域。
const FEISHU_NO_PROXY_SUFFIXES = [
  ".feishu.cn", ".larksuite.com", ".larkoffice.com",
  ".feishucdn.com", ".larksuitecdn.com", ".feishu-pre.cn",
];

/** 是否默认把飞书域名追加进沙箱 NO_PROXY(让 lark-cli 直连飞书,绕开会间歇 reset 飞书流量的翻墙代理)。
 *  默认开:已知部署(本地 WSL 翻墙代理 / 生产 VPS 无代理)都受益且无副作用(无代理时整段逻辑跳过)。
 *  仅"出网必须经代理、且代理能正常访问飞书"的特殊网络需设 QINGAGENT_SANDBOX_FEISHU_NO_PROXY=0 关闭。 */
function shouldBypassProxyForFeishu(): boolean {
  return process.env.QINGAGENT_SANDBOX_FEISHU_NO_PROXY !== "0";
}

// 用户身份环境以宿主 process.env 为底，但产品进程注入的内部状态不属于用户身份，
// 也不能随着任意命令外泄。前缀规则覆盖所有内部开关/token；数据库连接串单列拒绝。
const USER_IDENTITY_ENV_DENY_PREFIXES = ["QINGAGENT_"];
const USER_IDENTITY_ENV_DENYLIST = new Set(["DATABASE_URL"]);

/** 产品自带 Node 运行时在沙箱 PATH 上的站位。 */
export type NodeRuntimePathPlacement =
  /** 排在宿主 PATH **之前**:沙箱内的 `node` 一律用产品自带运行时。 */
  | "runtime-first"
  /** 排在宿主 PATH **之后**:宿主自己的 Node 优先,产品运行时只作"宿主没有 Node"时的兜底。 */
  | "host-first";

/**
 * 决定产品自带 Node 运行时排在宿主 PATH 前面还是后面。
 *
 * 病根(0729 真机):产品运行时以通用名 `node` 常驻 PATH 最前,于是用户自己装的
 * `#!/usr/bin/env node` CLI 被产品主程序(而非用户终端里的 Node)拉起。系统凭据存储
 * 按**调用程序身份**判权,身份一换就读不到用户终端里原有的登录态,CLI 只好转去重新授权。
 *
 * 口径与凭证墙档位保持一致(resolveCredentialWallMode),避免两套安全语义各说各话:
 * - **最宽档**(用户勾了「以后不用再问我」,或本就无文件隔离且放开了未隔离命令执行):
 *   命令本来就以用户本人身份直接执行,理应完整复用用户终端里的一切——**宿主 Node 优先**。
 *   产品运行时退到 PATH 末尾,只在宿主根本没有 `node` 时兜底(此时无任何宿主 Node 可劫持)。
 * - **标准档**(真文件隔离):宿主 Node 未必在沙箱里可执行,凭据本来也被读墙挡着,
 *   维持产品运行时优先,保证技能脚本稳定可跑。
 *
 * QINGAGENT_SANDBOX_NODE_RUNTIME 可显式指定:`system` = 永远宿主优先,`shim` = 永远产品优先。
 */
export function resolveNodeRuntimePathPlacement(): NodeRuntimePathPlacement {
  const forced = process.env.QINGAGENT_SANDBOX_NODE_RUNTIME;
  if (forced === "system") return "host-first";
  if (forced === "shim") return "runtime-first";
  return resolveCredentialWallMode() === "wide" ? "host-first" : "runtime-first";
}

/**
 * 给命令环境装配产品 CLI 与 Node 运行时 PATH。
 * 产品 CLI 始终优先；Node 运行时按安全档位/显式配置站在宿主 PATH 前或后。
 */
function applyProductPath(env: NodeJS.ProcessEnv): void {
  const sep = process.platform === "win32" ? ";" : ":";
  const basePath = env.PATH ?? env.Path ?? "";
  const runtimeFirst = resolveNodeRuntimePathPlacement() === "runtime-first";
  const productPath = [
    SANDBOX_BIN_DIR,
    ...(runtimeFirst ? [SANDBOX_NODE_RUNTIME_DIR] : []),
    ...(basePath ? [basePath] : []),
    ...(runtimeFirst ? [] : [SANDBOX_NODE_RUNTIME_DIR]),
  ].join(sep);
  env.PATH = productPath;
  // Windows 的环境变量名大小写不敏感，但各 CLI/运行时读取习惯不同，保持两种写法同步。
  if (process.platform === "win32") env.Path = productPath;
}

/** 有代理时把飞书官方域名并入 NO_PROXY，并同步大小写写法。 */
function mergeFeishuNoProxy(env: NodeJS.ProcessEnv): void {
  const hasProxy = !!(
    env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY ||
    env.https_proxy || env.http_proxy || env.all_proxy
  );
  if (!hasProxy || !shouldBypassProxyForFeishu()) return;

  const existing = [env.NO_PROXY, env.no_proxy]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(",")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const merged = Array.from(new Set([...existing, ...FEISHU_NO_PROXY_SUFFIXES])).join(",");
  env.NO_PROXY = merged;
  env.no_proxy = merged;
}

/** 沙箱进程 env:最小化——只带必需系统变量(按平台)+代理,绝不继承宿主全量环境或托管凭据。
 *  PATH 前置产品级 SANDBOX_BIN_DIR,让沙箱优先用产品自带/锁版本的 CLI(lark-cli 等);
 *  产品自带 Node 运行时单独成目录,按 resolveNodeRuntimePathPlacement 决定排在宿主前还是后。 */
export function buildSandboxEnv(effectiveHome?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const systemKeys = process.platform === "win32" ? SYSTEM_ENV_KEYS_WIN : SYSTEM_ENV_KEYS_POSIX;
  for (const key of [...systemKeys, ...USER_CLI_ENV_KEYS, ...PROXY_ENV_KEYS]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  applyProductPath(env);
  if (effectiveHome && process.platform !== "win32") env.HOME = effectiveHome;
  // 包管理器缓存改写进沙箱可写区,避免 npx/npm 去写只读的 ~/.npm 而被写墙打死。
  Object.assign(env, packageManagerCacheEnv());
  // 飞书域名并入 NO_PROXY:lark-cli 走代理连飞书会被不稳定的翻墙上游间歇 reset(实测),直连飞书稳定。
  // 仅在确实设了代理时才需要,可被 QINGAGENT_SANDBOX_FEISHU_NO_PROXY=0 关闭(给"飞书必须经代理"的环境)。
  mergeFeishuNoProxy(env);
  return env;
}

/**
 * 「不再询问」+ none 档的命令环境：按用户本人身份完整继承宿主 shell 环境。
 *
 * 260811 实证表明 CODEX_HOME 只是个案；API key、DBus/keyring 地址、自定义 HOME 指针、
 * 用户追加 PATH 都属于用户已有登录态，不能靠逐项白名单补洞。这里只剔除产品自身注入的
 * QINGAGENT_* 内部态与 DATABASE_URL，再叠加产品 CLI/Node PATH 和既有飞书 NO_PROXY 规则。
 * 该档没有写墙，包管理器应继续使用用户自己的缓存，因此不调用 packageManagerCacheEnv()。
 */
export function buildUserIdentityEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      USER_IDENTITY_ENV_DENYLIST.has(key) ||
      USER_IDENTITY_ENV_DENY_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      delete env[key];
    }
  }
  applyProductPath(env);
  mergeFeishuNoProxy(env);
  return env;
}

/**
 * 「这次调用必须用产品自带 Node 运行时」时叠加的 env(只影响本次调用)。
 *
 * 用途:产品自带的技能脚本 / CLI 是我们自己的代码,依赖的 Node 版本由产品保证,不该被
 * 宿主上装了什么版本左右;而用户自己的 CLI 必须走宿主 Node(见 resolveNodeRuntimePathPlacement)。
 * 两者的区别就落在这里——**按调用点显式指定运行时**,而不是给所有人挂一个全局 `node` 劫持。
 *
 * 产品运行时本来就排在最前(标准档)时返回空对象,不做任何无谓改写。
 */
export function productNodeRuntimePathEnv(basePath?: string): NodeJS.ProcessEnv {
  if (resolveNodeRuntimePathPlacement() === "runtime-first") return {};
  const sep = process.platform === "win32" ? ";" : ":";
  const currentPath = basePath ?? buildSandboxEnv().PATH ?? "";
  const merged = currentPath
    ? `${SANDBOX_NODE_RUNTIME_DIR}${sep}${currentPath}`
    : SANDBOX_NODE_RUNTIME_DIR;
  return process.platform === "win32" ? { PATH: merged, Path: merged } : { PATH: merged };
}

/** 额外只读挂载路径:给打包态 Electron/bwrap 暴露主二进制与 resources 深层依赖。 */
export function sandboxExtraReadOnlyPaths(): string[] {
  const raw = process.env.QINGAGENT_SANDBOX_EXTRA_READONLY_PATHS ?? "";
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const part of raw.split(delimiter)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const abs = resolve(trimmed);
    if (seen.has(abs)) continue;
    seen.add(abs);
    paths.push(abs);
  }
  return paths;
}

/** 安全开关口径:仅显式真值(1/true/yes/on,忽略大小写与空白)才视为开启;
 *  未设 / 空 / 0 / false / off / no / 其它一律关闭。用于高危能力默认安全。 */
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
export function isEnvEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return TRUTHY_ENV_VALUES.has(raw.trim().toLowerCase());
}

/** 是否允许向受信 node skill 脚本按次注入凭据。默认关闭(安全默认)，generic CLI、
 *  lark-cli 与 LocalSandbox 基础 env 均不受此开关影响、始终拿不到托管凭据；桌面主进程
 *  显式设 QINGAGENT_SANDBOX_INJECT_CREDENTIALS=1 补回本地登录态能力。 */
export function shouldInjectCredentials(): boolean {
  return isEnvEnabled(process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS);
}

/** isolation=none(无文件系统隔离,如 Windows/未装 bwrap)时是否仍暴露命令执行。
 *  默认关闭,要求服务端形态必须有真隔离才暴露命令;两条补回通道:
 *  ①全局处于「不再询问」——此时命令本就以用户本人身份(含完整用户环境)直接执行,
 *    再不暴露 execute_command 等于把这个开关做成空转;
 *  ②部署方显式设 QINGAGENT_ALLOW_UNISOLATED_COMMANDS=1(桌面主进程用它补回本地命令能力)。 */
export function allowUnisolatedCommands(): boolean {
  return isBypassEnabled() || isEnvEnabled(process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS);
}

/**
 * 凭证墙档位的唯一判定入口。
 *
 * 全局处于「不再询问」时即为最宽档:命令本来就以用户本人身份直接执行,凭证墙
 * 再收紧没有意义。除此之外按现有形态判定——完全不设文件隔离、且显式放开未隔离
 * 命令执行,同样是语义上的最宽档。
 */
export function resolveCredentialWallMode(): CredentialWallMode {
  if (isBypassEnabled()) return "wide";
  return resolveIsolation() === "none" && allowUnisolatedCommands() ? "wide" : "standard";
}

/**
 * 本次会话真正要放行的凭证路径:已授权 ∩ 当前仍被已启用技能声明。
 * 授权被回收、技能被关掉、声明被删掉,下次构建沙箱即自动收回。
 */
export async function resolveSandboxCredentialPaths(
  loadGrants: () => Promise<CredentialGrantRef[]>,
): Promise<string[]> {
  const [grants, requests] = await Promise.all([
    loadGrants().catch(() => [] as CredentialGrantRef[]),
    listCredentialRequests().catch(() => []),
  ]);
  const paths = selectEffectiveCredentialPaths(grants, requests);
  // 目录不存在就 bind 不上;CLI 首登也要往里写,先建出来(0700)。
  await Promise.all(paths.map((path) => ensureCredentialPathExists(path)));
  return paths;
}

export interface SessionWorkspaceFactoryOptions {
  /** 解析已启用技能目录(与全局 Workspace 共用同一来源)。 */
  resolveSkillDirs: () => Promise<string[]> | string[];
  /** 解析本会话已连接的只读本地资料库。 */
  resolveFolderSources?: (sessionId: string) => Promise<FolderSourceRecord[]> | FolderSourceRecord[];
}

interface CacheEntry {
  workspace: Workspace;
  lastAccessAt: number;
  leaseCount: number;
  pendingDestroy: boolean;
  destroyStarted: boolean;
}

export interface SessionWorkspaceLease {
  workspace: Workspace;
  /** 为同一 Workspace 增加一个活动引用，返回幂等释放函数。 */
  retain: () => () => void;
  /** 释放当前租约；可重复调用。 */
  release: () => void;
}

/** 会话 Workspace 缓存:stream 每轮都会解析 workspace,不能每次重建。
 *  上限驱逐防长寿进程内存膨胀(Workspace 本体很轻,512 足够宽裕)。 */
const MAX_CACHED_WORKSPACES = 512;
const cache = new Map<string, CacheEntry>();
/** 已从可获取缓存摘除、但仍被旧租约引用的 entry。 */
const retiredEntries = new Map<string, Set<CacheEntry>>();
/** 同一 key 正在首建的 Promise:并发去重,避免重复构建游离实例(见 getSessionWorkspace)。 */
const inflight = new Map<string, Promise<CacheEntry>>();
/** acquire 发起到租约落账之间的同步预留，封住 Promise continuation 前的失效竞态。 */
const pendingAcquires = new Map<string, number>();
/** 每个会话 Workspace 的构建代际:invalidate 后旧构建结果不得回写缓存。 */
const generation = new Map<string, number>();
/** 已从 inflight 摘除但还没 settle 的旧构建也要保留 generation,否则会旧结果回写。 */
const activeBuilds = new Map<string, number>();

function destroyWorkspaceQuietly(workspace: Workspace): void {
  void destroyWorkspace(workspace);
}

async function destroyWorkspace(workspace: Workspace): Promise<void> {
  try {
    await workspace.destroy();
  } catch (error) {
    console.error("[sessionWorkspace] destroy workspace failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function removeAndDestroyEntry(key: string, entry: CacheEntry): void {
  if (entry.destroyStarted) return;
  if (cache.get(key) === entry) cache.delete(key);
  const retired = retiredEntries.get(key);
  if (retired) {
    retired.delete(entry);
    if (retired.size === 0) retiredEntries.delete(key);
  }
  entry.destroyStarted = true;
  destroyWorkspaceQuietly(entry.workspace);
  trimGenerationKey(key);
}

function markEntryForDestroy(key: string, entry: CacheEntry): void {
  entry.pendingDestroy = true;
  // 失效 entry 立即退出可获取缓存；旧 lease 只负责延迟它自己的销毁，
  // 后续 acquire 必须重新装配凭据、技能和资料库挂载。
  if (cache.get(key) === entry) cache.delete(key);
  let retired = retiredEntries.get(key);
  if (!retired) {
    retired = new Set();
    retiredEntries.set(key, retired);
  }
  retired.add(entry);
  if (entry.leaseCount === 0 && !pendingAcquires.has(key)) {
    removeAndDestroyEntry(key, entry);
  }
}

function releaseEntry(key: string, entry: CacheEntry): void {
  if (entry.leaseCount === 0) return;
  entry.leaseCount -= 1;
  if (entry.leaseCount === 0 && entry.pendingDestroy && !pendingAcquires.has(key)) {
    removeAndDestroyEntry(key, entry);
    return;
  }
  evictIfNeeded();
}

function retainEntry(key: string, entry: CacheEntry): () => void {
  entry.leaseCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseEntry(key, entry);
  };
}

function reserveAcquire(key: string): void {
  pendingAcquires.set(key, (pendingAcquires.get(key) ?? 0) + 1);
}

function releaseAcquireReservation(key: string): void {
  const next = (pendingAcquires.get(key) ?? 0) - 1;
  if (next > 0) pendingAcquires.set(key, next);
  else pendingAcquires.delete(key);
  if (!pendingAcquires.has(key)) {
    for (const entry of [...(retiredEntries.get(key) ?? [])]) {
      if (entry.leaseCount === 0) removeAndDestroyEntry(key, entry);
    }
  }
  trimGenerationKey(key);
}

function evictIfNeeded(): void {
  while (cache.size > MAX_CACHED_WORKSPACES) {
    const entries = [...cache.entries()].sort(
      (left, right) => left[1].lastAccessAt - right[1].lastAccessAt,
    );
    const oldest = entries[0];
    if (!oldest) return;
    const [oldestKey, oldestEntry] = oldest;
    if (oldestEntry.leaseCount > 0 || pendingAcquires.has(oldestKey)) {
      markEntryForDestroy(oldestKey, oldestEntry);
    } else {
      removeAndDestroyEntry(oldestKey, oldestEntry);
    }
  }
}

function incrementActiveBuild(key: string): void {
  activeBuilds.set(key, (activeBuilds.get(key) ?? 0) + 1);
}

function decrementActiveBuild(key: string): void {
  const next = (activeBuilds.get(key) ?? 0) - 1;
  if (next > 0) activeBuilds.set(key, next);
  else activeBuilds.delete(key);
}

function trimGenerationKey(key: string): void {
  if (
    !cache.has(key) &&
    !retiredEntries.has(key) &&
    !inflight.has(key) &&
    !activeBuilds.has(key) &&
    !pendingAcquires.has(key)
  ) {
    generation.delete(key);
  }
}

/** 仅测试用:清空缓存。 */
export function __resetSessionWorkspaceCacheForTest(): void {
  cache.clear();
  retiredEntries.clear();
  inflight.clear();
  pendingAcquires.clear();
  generation.clear();
  activeBuilds.clear();
}

/** 仅测试用:观察私有缓存 map 是否被正确清理。 */
export function __sessionWorkspaceCacheStatsForTest(): {
  cacheSize: number;
  inflightSize: number;
  generationSize: number;
  activeBuildSize: number;
  leaseCount: number;
  pendingAcquireCount: number;
  pendingDestroyCount: number;
  generationKeys: string[];
} {
  const entries = [
    ...cache.values(),
    ...[...retiredEntries.values()].flatMap((retired) => [...retired]),
  ];
  return {
    cacheSize: cache.size,
    inflightSize: inflight.size,
    generationSize: generation.size,
    activeBuildSize: activeBuilds.size,
    leaseCount: entries.reduce((sum, entry) => sum + entry.leaseCount, 0),
    pendingAcquireCount: [...pendingAcquires.values()].reduce((sum, count) => sum + count, 0),
    pendingDestroyCount: entries.filter((entry) => entry.pendingDestroy).length,
    generationKeys: [...generation.keys()],
  };
}

/** 凭据变更后让会话 Workspace 缓存失效；无活动租约时立即回收，否则延迟到最后释放。
 *  不传 sessionId 则全量失效(凭据是全局 scope,任一变更影响所有会话沙箱)。 */
export function invalidateSessionWorkspace(sessionId?: string): void {
  if (sessionId) {
    const key = sessionWorkspaceDirName(sessionId);
    generation.set(key, (generation.get(key) ?? 0) + 1);
    const entry = cache.get(key);
    if (entry) markEntryForDestroy(key, entry);
    inflight.delete(key);
    trimGenerationKey(key);
  } else {
    const keys = new Set([
      ...cache.keys(),
      ...inflight.keys(),
      ...generation.keys(),
      ...activeBuilds.keys(),
      ...pendingAcquires.keys(),
    ]);
    for (const key of keys) {
      generation.set(key, (generation.get(key) ?? 0) + 1);
    }
    for (const [key, entry] of [...cache]) {
      markEntryForDestroy(key, entry);
    }
    inflight.clear();
    for (const key of keys) trimGenerationKey(key);
  }
}

/** 会话删除时清理其沙箱工作目录(模型写的中间文件/产物),并移除 Workspace 缓存。
 *  失败不抛(目录可能不存在或被占用),只记日志。 */
export async function cleanupSessionWorkspace(sessionId: string): Promise<void> {
  invalidateSessionWorkspace(sessionId);
  const key = sessionWorkspaceDirName(sessionId);
  const roots = [
    { root: SANDBOX_SESSIONS_BASE, storage: "会话沙箱目录" },
    { root: join(QINGAGENT_DATA_DIR, "folder-source-cache"), storage: "资料库解析缓存" },
  ];
  for (const { root, storage } of roots) {
    try {
      await rm(join(root, key), { recursive: true, force: true });
    } catch (error) {
      console.error(`[sessionWorkspace] 清理${storage}失败`, { sessionId, error });
    }
  }
  trimGenerationKey(key);
}

export async function getSessionWorkspace(
  sessionId: string,
  opts: SessionWorkspaceFactoryOptions,
): Promise<Workspace> {
  return (await getSessionWorkspaceEntry(sessionId, opts)).workspace;
}

export async function acquireSessionWorkspace(
  sessionId: string,
  opts: SessionWorkspaceFactoryOptions,
): Promise<SessionWorkspaceLease> {
  const key = sessionWorkspaceDirName(sessionId);
  reserveAcquire(key);
  try {
    const entry = await getSessionWorkspaceEntry(sessionId, opts);
    const release = retainEntry(key, entry);
    releaseAcquireReservation(key);
    return {
      workspace: entry.workspace,
      retain: () => retainEntry(key, entry),
      release,
    };
  } catch (error) {
    releaseAcquireReservation(key);
    throw error;
  }
}

async function getSessionWorkspaceEntry(
  sessionId: string,
  opts: SessionWorkspaceFactoryOptions,
): Promise<CacheEntry> {
  const key = sessionWorkspaceDirName(sessionId);
  const hit = cache.get(key);
  if (hit) {
    hit.lastAccessAt = Date.now();
    return hit;
  }

  // 并发去重:同一 key 首次构建时只建一次,其余并发调用 await 同一 Promise。
  // 否则 cache miss 与 cache.set 之间有异步资料源解析让出事件循环,
  // 并发多路会各建一个 Workspace → 泄漏 N-1 个游离实例 + 破坏单例语义(R9 BUG-1)。
  const pending = inflight.get(key);
  if (pending) return pending;

  const buildGeneration = generation.get(key) ?? 0;
  incrementActiveBuild(key);
  const building = (async () => {
    const workspace = await buildSessionWorkspace(sessionId, opts);
    if ((generation.get(key) ?? 0) === buildGeneration) {
      const entry: CacheEntry = {
        workspace,
        lastAccessAt: Date.now(),
        leaseCount: 0,
        pendingDestroy: false,
        destroyStarted: false,
      };
      cache.set(key, entry);
      evictIfNeeded();
      return entry;
    }
    // invalidate 已推进代际：旧实例既不能回写，也不能交给调用方成为游离 workspace。
    // 先完整销毁，再复用/构建当前代实例。
    await destroyWorkspace(workspace);
    return getSessionWorkspaceEntry(sessionId, opts);
  })();
  inflight.set(key, building);
  try {
    return await building;
  } finally {
    if (inflight.get(key) === building) inflight.delete(key);
    decrementActiveBuild(key);
    trimGenerationKey(key);
  }
}

async function buildSessionWorkspace(
  sessionId: string,
  opts: SessionWorkspaceFactoryOptions,
): Promise<Workspace> {
  const sessionDir = sessionWorkspaceDir(sessionId);
  // 同步确保目录存在:Workspace 装配在 stream 起步路径上,异步竞态不值得
  mkdirSync(sessionDir, { recursive: true });
  // 缓存与技能目录必须先存在,写墙才能把它们 bind 成可写(bwrap 对不存在的路径无法 bind)。
  mkdirSync(SANDBOX_PACKAGE_CACHE_DIR, { recursive: true });
  for (const skillsDir of [USER_SKILLS_DIR]) {
    try {
      mkdirSync(skillsDir, { recursive: true });
    } catch {
      // 安装目录创建失败不该拖垮整个工作区装配,后续发现会按空目录处理。
    }
  }

  // 装配前刷新一次全局免询问状态:开关是全局且低频变更的,这里刷新既保证本次装配
  // 用的是最新形态,也顺带把进程内缓存预热给同步读取方(工具门禁/系统提示词)。
  await loadBypassMode().catch(() => undefined);
  const isolation = resolveEffectiveIsolation();
  const extraReadOnlyPaths = sandboxExtraReadOnlyPaths();
  // 无文件系统隔离(none)且未显式允许时:不装 sandbox(不暴露命令执行),
  // 只留文件工具+技能发现。多租户服务器靠此强制要求真隔离。
  const isolationCommandsAllowed = isolation !== "none" || allowUnisolatedCommands();
  let readWall: PreparedReadWall | null = null;
  if (isolation === "seatbelt" || isolation === "bwrap") {
    try {
      const grantedCredentialPaths = await resolveSandboxCredentialPaths(
        () => listCredentialGrants(),
      );
      readWall = await prepareReadWall({
        platform: isolation === "seatbelt" ? "darwin" : "linux",
        env: process.env,
        sandboxEnv: buildSandboxEnv(),
        dataDir: QINGAGENT_DATA_DIR,
        sessionDir,
        sandboxBinDir: SANDBOX_BIN_DIR,
        builtinSkillsDir: BUILTIN_SKILLS_DIR,
        userSkillsDir: USER_SKILLS_DIR,
        extraUserSkillsDirs: USER_SKILL_SOURCE_DIRS.filter((dir) => dir !== USER_SKILLS_DIR),
        packageCacheDir: SANDBOX_PACKAGE_CACHE_DIR,
        extraReadOnlyPaths,
        grantedCredentialPaths,
        credentialWallMode: resolveCredentialWallMode(),
        nodeExecutable: process.execPath,
      });
      console.info("[sessionWorkspace] read-wall ready", {
        version: "v1",
        mode: readWall.mode,
        ruleCount: readWall.ruleCount,
        policyHash: readWall.policyHash,
        credentialWallMode: readWall.credentialWallMode,
        // 路径含宿主用户名,只报条数不报原文。
        credentialPathCount: readWall.credentialPaths.length,
        warnings: readWall.warnings,
      });
    } catch (error) {
      // 路径可能含宿主用户名/目录，日志只记错误类型，不输出原始 message/path。
      console.error("[sessionWorkspace] read-wall fail-closed", {
        isolation,
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  // Windows/显式 none 维持原有开关语义；Mac/Linux 真隔离必须先通过读墙全套预检。
  let commandsEnabled = isolationCommandsAllowed && (isolation === "none" || readWall !== null);
  const rawFolderSources = Array.from(
    (await opts.resolveFolderSources?.(sessionId)) ??
    getSessionFolderSources(sessionId),
  );
  for (const source of rawFolderSources) {
    if (normalizeFolderSourceRecord(source)) continue;
    const sourceId =
      source && typeof source === "object" && typeof (source as { id?: unknown }).id === "string"
        ? (source as { id: string }).id
        : null;
    console.warn("[sessionWorkspace] skip invalid folder source", {
      sessionId,
      sourceId,
    });
  }
  const normalizedFolderSources = normalizeFolderSourceRecords(rawFolderSources);
  const folderSources: FolderSourceRecord[] = [];
  for (const source of normalizedFolderSources) {
    if (source.status !== "connected") {
      console.warn("[sessionWorkspace] skip invalid folder source", {
        sessionId,
        sourceId: source.id,
      });
      continue;
    }
    if (source.provider === "desktop-local" && !localFolderSourcesEnabled()) {
      console.warn("[sessionWorkspace] skip disabled desktop-local folder source", {
        sessionId,
        sourceId: source.id,
      });
      continue;
    }
    if (source.provider === "browser-fs-access" && !browserFolderSourcesEnabled()) {
      console.warn("[sessionWorkspace] skip disabled browser-fs-access folder source", {
        sessionId,
        sourceId: source.id,
      });
      continue;
    }
    folderSources.push(source);
  }
  const mounts: Record<string, WorkspaceFilesystem> = {
    // 会话私有读写区:模型写代码/中间数据/产物都在这里
    "/workspace": new RedactedSymlinkTargetFilesystem(
      new LocalFilesystem({ basePath: sessionDir }),
      "/workspace",
      [sessionDir],
    ),
    // 技能区只读共享:skill 脚本可被读取与执行,不可被模型改写
    "/skills": new RedactedSymlinkTargetFilesystem(
      new LocalFilesystem({
        basePath: BUILTIN_SKILLS_DIR,
        allowedPaths: [...USER_SKILL_SOURCE_DIRS],
        readOnly: true,
      }),
      "/skills",
      [BUILTIN_SKILLS_DIR, ...USER_SKILL_SOURCE_DIRS],
    ),
  };

  if (folderSources.length > 0) {
    const sourceMounts: Record<string, WorkspaceFilesystem> = {};
    for (const source of folderSources) {
      const filesystem = createFolderSourceFilesystem(source);
      if (!filesystem) {
        console.warn("[sessionWorkspace] skip unsupported folder source", {
          sessionId,
          sourceId: source.id,
          provider: source.provider,
        });
        continue;
      }
      sourceMounts[`/${source.mountName}`] = filesystem;
    }
    if (Object.keys(sourceMounts).length > 0) {
      mounts["/sources"] = new CompositeFilesystem({
        mounts: sourceMounts,
      });
    }
  }

  let sandbox: LocalSandbox | ReadWallLocalSandbox | undefined;
  if (commandsEnabled) {
    try {
      sandbox = readWall
        ? new ReadWallLocalSandbox({
            workingDirectory: sessionDir,
            isolation,
            nativeSandbox: readWall.nativeSandbox,
            // 托管凭据不得进入 LocalSandbox 基础 env；仅由 gatedExecuteCommandTool
            // 对受信 node skill 脚本按次发放，generic CLI 与 lark-cli 始终看不到。
            env: buildSandboxEnv(readWall.effectiveHome),
            timeout: SANDBOX_TIMEOUT_MS,
            verifyReadWallIntegrity: readWall.verifyIntegrity,
          })
        : new LocalSandbox({
            workingDirectory: sessionDir,
            isolation,
            nativeSandbox: {
              // CLI skill 要调开放 API,必须放网;文件面仍然兜死
              allowNetwork: true,
              // 技能目录 + 产品级 CLI 目录只读可执行(bwrap/seatbelt 隔离下访问 lark-cli 等)
              readOnlyPaths: [
                BUILTIN_SKILLS_DIR,
                ...USER_SKILL_SOURCE_DIRS.filter((dir) => dir !== USER_SKILLS_DIR),
                SANDBOX_BIN_DIR,
                ...extraReadOnlyPaths,
              ],
              // 仅现装目录与包缓存可写；legacy 自有目录及外部 agent 技能目录保持只读。
              readWritePaths: [
                sessionDir,
                USER_SKILLS_DIR,
                SANDBOX_PACKAGE_CACHE_DIR,
              ],
            },
            // 260811 档位语义：仅「不再询问」造成的 none 才按用户本人身份带完整环境；
            // 非 bypass 的 none（部署方显式放行）仍是防御边界，继续使用最小白名单。
            env: isolation === "none" && isBypassEnabled()
              ? buildUserIdentityEnv()
              : buildSandboxEnv(),
            timeout: SANDBOX_TIMEOUT_MS,
          });
    } catch (error) {
      commandsEnabled = false;
      console.error("[sessionWorkspace] sandbox construction fail-closed", {
        isolation,
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  const toolsConfig: Record<string, { enabled: boolean }> = {};
  if (commandsEnabled) {
    toolsConfig[WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND] = { enabled: false };
    // 与 execute_command 一样禁用 Mastra 原生实现，再由 sessionScoped 注入有界等待版本。
    // 否则 workspace 原生工具优先于同名 toolset，bounded 覆盖不会实际生效。
    toolsConfig[WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT] = { enabled: false };
  }
  if (folderSources.length > 0) {
    // /sources 正文只能经 readDocument/searchDocuments 的受控契约进入模型。
    // Mastra 内置 read_file/list_files/edit_file/grep/search 先禁用，再由 sessionScoped 注入同 id 包装工具。
    toolsConfig[WORKSPACE_TOOLS.FILESYSTEM.READ_FILE] = { enabled: false };
    toolsConfig[WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES] = { enabled: false };
    toolsConfig[WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE] = { enabled: false };
    toolsConfig[WORKSPACE_TOOLS.FILESYSTEM.GREP] = { enabled: false };
    toolsConfig[WORKSPACE_TOOLS.SEARCH.SEARCH] = { enabled: false };
  }

  const workspace = new Workspace({
    filesystem: new SessionCompositeFilesystem({ mounts }),
    bm25: true,
    // 技能发现源:必须独立于上面的 CompositeFilesystem。resolveSkillDirs 返回的是
    // 宿主绝对路径(packages/core/skills/capability/...),而 CompositeFilesystem 只认
    // /workspace 与 /skills 两个虚拟挂载前缀——Mastra 默认拿 workspace.filesystem 当
    // skillSource,绝对路径在组合文件系统里匹配不到任何挂载 → 技能列表恒为空(实测:
    // skill/skill_search 全返回 "No results found",doc-calc/feishu 全失效)。
    // 显式传 LocalSkillSource(按宿主 fs 解析绝对路径)把技能发现与命令 cwd 解耦。
    skillSource: new LocalSkillSource(),
    ...(Object.keys(toolsConfig).length > 0 ? { tools: toolsConfig } : {}),
    ...(sandbox ? { sandbox } : {}),
    skills: opts.resolveSkillDirs,
  });

  return workspace;
}

function createFolderSourceFilesystem(source: FolderSourceRecord): WorkspaceFilesystem | null {
  if (source.provider === "browser-fs-access") {
    if (!source.browserClientSourceId || !source.browserHandleKey) return null;
    return new BrowserBridgeFilesystem(source);
  }
  if (source.provider === "desktop-local" && source.desktopRootPath) {
    const local = new LocalFilesystem({
      id: source.id,
      basePath: source.desktopRootPath,
      readOnly: true,
      contained: true,
    });
    return new RedactedFolderSourceFilesystem(local, source);
  }
  return null;
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function replaceAllLiteral(input: string, search: string, replacement: string): string {
  return search ? input.split(search).join(replacement) : input;
}

function isSourcesVirtualPath(path: string): boolean {
  return path === "/sources" || path.startsWith("/sources/");
}

class SessionCompositeFilesystem extends CompositeFilesystem {
  private resolveSessionPath(path: string): string {
    if (isAbsolute(path) || path.startsWith("/")) return path;
    const normalized = posix.normalize(path.replaceAll("\\", "/"));
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`Path escapes the workspace: ${path}`);
    }
    return normalized === "." ? "/workspace" : posix.join("/workspace", normalized);
  }

  getFilesystemForPath(path: string): WorkspaceFilesystem | undefined {
    return super.getFilesystemForPath(this.resolveSessionPath(path));
  }

  getMountPathForPath(path: string): string | undefined {
    return super.getMountPathForPath(this.resolveSessionPath(path));
  }

  resolveAbsolutePath(path: string): string | undefined {
    return super.resolveAbsolutePath(this.resolveSessionPath(path));
  }

  readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
    return super.readFile(this.resolveSessionPath(path), options);
  }

  writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    return super.writeFile(this.resolveSessionPath(path), content, {
      ...options,
      // 文件工具只负责写文件；父目录不存在时应由 mkdir 显式创建。
      recursive: options?.recursive ?? false,
    });
  }

  appendFile(path: string, content: FileContent): Promise<void> {
    return super.appendFile(this.resolveSessionPath(path), content);
  }

  deleteFile(path: string, options?: RemoveOptions): Promise<void> {
    return super.deleteFile(this.resolveSessionPath(path), options);
  }

  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    const resolvedSrc = this.resolveSessionPath(src);
    const resolvedDest = this.resolveSessionPath(dest);
    if (isSourcesVirtualPath(resolvedSrc) && !isSourcesVirtualPath(resolvedDest)) {
      throw new Error("copyFile from /sources is not allowed; use readDocument or searchDocuments for folder sources");
    }
    return super.copyFile(resolvedSrc, resolvedDest, options);
  }

  moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    return super.moveFile(this.resolveSessionPath(src), this.resolveSessionPath(dest), options);
  }

  readdir(path: string, options?: ListOptions): Promise<FileEntry[]> {
    return super.readdir(this.resolveSessionPath(path), options);
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return super.mkdir(this.resolveSessionPath(path), options);
  }

  rmdir(path: string, options?: RemoveOptions): Promise<void> {
    return super.rmdir(this.resolveSessionPath(path), options);
  }

  exists(path: string): Promise<boolean> {
    return super.exists(this.resolveSessionPath(path));
  }

  stat(path: string): Promise<FileStat> {
    return super.stat(this.resolveSessionPath(path));
  }

  isFile(path: string): Promise<boolean> {
    return super.isFile(this.resolveSessionPath(path));
  }

  isDirectory(path: string): Promise<boolean> {
    return super.isDirectory(this.resolveSessionPath(path));
  }
}

class RedactedSymlinkTargetFilesystem implements WorkspaceFilesystem {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly readOnly?: boolean;
  readonly basePath?: string;
  readonly icon?: WorkspaceFilesystem["icon"];
  readonly displayName?: string;
  readonly description?: string;

  constructor(
    private readonly delegate: WorkspaceFilesystem,
    private readonly virtualRoot: string,
    private readonly redactedRoots: string[],
  ) {
    this.id = delegate.id;
    this.name = delegate.name;
    this.provider = delegate.provider;
    this.readOnly = delegate.readOnly;
    this.basePath = delegate.basePath;
    this.icon = delegate.icon;
    this.displayName = delegate.displayName;
    this.description = delegate.description;
  }

  get status(): WorkspaceFilesystem["status"] {
    return this.delegate.status;
  }

  set status(value: WorkspaceFilesystem["status"]) {
    this.delegate.status = value;
  }

  get error(): string | undefined {
    return this.delegate.error;
  }

  set error(value: string | undefined) {
    this.delegate.error = value;
  }

  init(): Promise<void> | void {
    return this.delegate.init?.();
  }

  destroy(): Promise<void> | void {
    return this.delegate.destroy?.();
  }

  isReady(): Promise<boolean> | boolean {
    return this.delegate.isReady?.() ?? true;
  }

  getInfo(): FilesystemInfo | Promise<FilesystemInfo> {
    return this.delegate.getInfo?.() ?? {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: "ready",
      readOnly: this.readOnly,
      icon: this.icon,
      metadata: {},
    };
  }

  getInstructions(opts?: Parameters<NonNullable<WorkspaceFilesystem["getInstructions"]>>[0]): string {
    return this.delegate.getInstructions?.(opts) ?? "";
  }

  private sanitizeText(text: string): string {
    let sanitized = text;
    for (const root of this.redactedRoots) {
      sanitized = replaceAllLiteral(sanitized, root, this.virtualRoot);
    }
    if (this.basePath) sanitized = replaceAllLiteral(sanitized, this.basePath, this.virtualRoot);
    return sanitized;
  }

  private sanitizeError(error: unknown): Error {
    if (!(error instanceof Error)) return new Error(this.sanitizeText(String(error)));
    const sanitized = new Error(this.sanitizeText(error.message));
    sanitized.name = error.name;
    // Mastra 的 write tracker 依赖 instanceof FileNotFoundError 识别“新文件”。
    // 保留错误原型，同时仍只暴露清洗后的 message，避免宿主路径泄露。
    Object.setPrototypeOf(sanitized, Object.getPrototypeOf(error));
    return sanitized;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.sanitizeError(error);
    }
  }

  resolveAbsolutePath(path: string): string | undefined {
    return this.delegate.resolveAbsolutePath?.(path);
  }

  realpath(path: string): Promise<string> {
    return this.delegate.realpath?.(path) ?? Promise.resolve(path);
  }

  readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
    return this.call(() => this.delegate.readFile(path, options));
  }

  writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    return this.call(() => this.delegate.writeFile(path, content, options));
  }

  appendFile(path: string, content: FileContent): Promise<void> {
    return this.call(() => this.delegate.appendFile(path, content));
  }

  deleteFile(path: string, options?: RemoveOptions): Promise<void> {
    return this.call(() => this.delegate.deleteFile(path, options));
  }

  copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    return this.call(() => this.delegate.copyFile(src, dest, options));
  }

  moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    return this.call(() => this.delegate.moveFile(src, dest, options));
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.call(() => this.delegate.mkdir(path, options));
  }

  rmdir(path: string, options?: RemoveOptions): Promise<void> {
    return this.call(() => this.delegate.rmdir(path, options));
  }

  async readdir(path: string, options?: ListOptions): Promise<FileEntry[]> {
    const entries = await this.call(() => this.delegate.readdir(path, options));
    return entries.map((entry) => {
      if (!entry.isSymlink) return entry;
      const { symlinkTarget: _symlinkTarget, ...rest } = entry;
      return rest;
    });
  }

  exists(path: string): Promise<boolean> {
    return this.call(() => this.delegate.exists(path));
  }

  stat(path: string): Promise<FileStat> {
    return this.call(() => this.delegate.stat(path));
  }
}

class RedactedFolderSourceFilesystem implements WorkspaceFilesystem {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly readOnly = true;
  readonly basePath: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly icon?: WorkspaceFilesystem["icon"];
  private readonly rootPath: string;
  private readonly virtualRoot: string;

  constructor(
    private readonly delegate: LocalFilesystem,
    private readonly source: FolderSourceRecord,
  ) {
    this.id = delegate.id;
    this.name = delegate.name;
    this.provider = delegate.provider;
    this.rootPath = resolve(source.desktopRootPath ?? "");
    this.virtualRoot = source.mountPath;
    this.basePath = this.virtualRoot;
    this.displayName = source.name;
    this.description = `只读资料库「${source.name}」`;
  }

  get status(): LocalFilesystem["status"] {
    return this.delegate.status;
  }

  set status(value: LocalFilesystem["status"]) {
    this.delegate.status = value;
  }

  get error(): string | undefined {
    return this.delegate.error;
  }

  set error(value: string | undefined) {
    this.delegate.error = value;
  }

  private absoluteForWorkspacePath(path: string): string {
    return resolve(this.rootPath, path.replace(/^\/+/, ""));
  }

  private sanitizeText(text: string): string {
    let sanitized = replaceAllLiteral(text, this.rootPath, this.virtualRoot);
    const rawRoot = this.source.desktopRootPath;
    if (rawRoot) sanitized = replaceAllLiteral(sanitized, rawRoot, this.virtualRoot);
    return sanitized;
  }

  private sanitizeError(error: unknown): Error {
    if (!(error instanceof Error)) return new Error(this.sanitizeText(String(error)));
    const sanitized = new Error(this.sanitizeText(error.message));
    sanitized.name = error.name;
    Object.setPrototypeOf(sanitized, Object.getPrototypeOf(error));
    return sanitized;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.sanitizeError(error);
    }
  }

  private async shouldKeepSymlink(dir: string, entry: FileEntry): Promise<boolean> {
    if (!entry.isSymlink || !entry.symlinkTarget) return true;
    const target = entry.symlinkTarget;
    const targetAbs = isAbsolute(target)
      ? resolve(target)
      : resolve(this.absoluteForWorkspacePath(dir), target);
    if (!isPathInside(targetAbs, this.rootPath)) return false;
    try {
      const entryAbs = resolve(this.absoluteForWorkspacePath(dir), entry.name);
      const finalAbs = await realpath(entryAbs);
      return isPathInside(finalAbs, this.rootPath);
    } catch {
      return true;
    }
  }

  private async sanitizeEntry(dir: string, entry: FileEntry): Promise<FileEntry | null> {
    if (!(await this.shouldKeepSymlink(dir, entry))) return null;
    if (!entry.isSymlink) return entry;
    const { symlinkTarget: _symlinkTarget, ...rest } = entry;
    return rest;
  }

  init(): Promise<void> {
    return this.call(() => this.delegate.init());
  }

  destroy(): Promise<void> {
    return this.call(() => this.delegate.destroy());
  }

  getInfo(): FilesystemInfo {
    const info = this.delegate.getInfo();
    return {
      ...info,
      id: this.id,
      name: this.name,
      provider: this.provider,
      readOnly: true,
      icon: this.icon,
      metadata: {
        ...info.metadata,
        basePath: this.virtualRoot,
        allowedPaths: undefined,
      },
    };
  }

  readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
    return this.call(() => this.delegate.readFile(path, options));
  }

  writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    return this.call(() => this.delegate.writeFile(path, content, options));
  }

  appendFile(path: string, content: FileContent): Promise<void> {
    return this.call(() => this.delegate.appendFile(path, content));
  }

  deleteFile(path: string, options?: RemoveOptions): Promise<void> {
    return this.call(() => this.delegate.deleteFile(path, options));
  }

  copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    return this.call(() => this.delegate.copyFile(src, dest, options));
  }

  moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    return this.call(() => this.delegate.moveFile(src, dest, options));
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.call(() => this.delegate.mkdir(path, options));
  }

  rmdir(path: string, options?: RemoveOptions): Promise<void> {
    return this.call(() => this.delegate.rmdir(path, options));
  }

  async readdir(path: string, options?: ListOptions): Promise<FileEntry[]> {
    return this.call(async () => {
      const entries = await this.delegate.readdir(path, options);
      const sanitizedEntries = await Promise.all(
        entries.map((entry) => this.sanitizeEntry(path, entry)),
      );
      return sanitizedEntries.filter((entry): entry is FileEntry => entry !== null);
    });
  }

  exists(path: string): Promise<boolean> {
    return this.call(() => this.delegate.exists(path));
  }

  stat(path: string): Promise<FileStat> {
    return this.call(() => this.delegate.stat(path));
  }

  realpath(path: string): Promise<string> {
    return this.call(() => this.delegate.realpath(path));
  }
}
