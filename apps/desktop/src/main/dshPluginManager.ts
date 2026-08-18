import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DshDetectionSnapshot,
  DshInstallResult,
  DshProfileSnapshot,
} from "../dshPluginContract.js";

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const INSTALL_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 24_000;

export interface DshInstallInvocation {
  command: string;
  args: string[];
  options: SpawnOptions & { shell: false };
}

interface NpxLookupOptions {
  encoding: "utf8";
  shell: false;
  windowsHide: true;
}

export interface NpxExecutableResolutionOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  lookup?: (command: string, args: readonly string[], options: NpxLookupOptions) => string;
  isFile?: (filePath: string) => boolean;
  readDirectory?: (directoryPath: string) => string[];
}

export interface DshDetectionRuntimeOptions {
  resolveNpx?: () => string | null;
}

export interface DshInstallRuntimeOptions {
  homeDir?: string;
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
  resolveNpx?: () => string | null;
}

let installRunning = false;

export function detectDshInstallation(
  homeDir = os.homedir(),
  runtime: DshDetectionRuntimeOptions = {},
): DshDetectionSnapshot {
  const dshDir = path.join(homeDir, ".dsh");
  const settingsPath = path.join(dshDir, "settings.yaml");
  const profilesDir = path.join(dshDir, "profiles");
  if (!isFile(settingsPath) || !isDirectory(profilesDir)) {
    return { detected: false, profiles: [], defaultProfile: null, npxAvailable: false };
  }

  const profiles = readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PROFILE_NAME_PATTERN.test(entry.name))
    .map((entry) => readProfile(profilesDir, entry.name))
    .filter((profile): profile is DshProfileSnapshot => profile !== null)
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const defaultProfile = profiles.find(
    (profile) => profile.name === "web" && profile.bundles.includes("dsh-web-app"),
  )?.name ?? profiles.find(
    (profile) => profile.bundles.includes("dsh-web-app"),
  )?.name ?? profiles[0]?.name ?? null;

  const resolveNpx = runtime.resolveNpx ?? (() => resolveNpxExecutable({ homeDir }));
  return {
    detected: true,
    profiles,
    defaultProfile,
    npxAvailable: safeResolveNpx(resolveNpx) !== null,
  };
}

export function buildDshInstallInvocation(
  profile: string,
  detectedProfiles: readonly string[],
  npxExecutable: string,
): DshInstallInvocation {
  if (!PROFILE_NAME_PATTERN.test(profile) || !detectedProfiles.includes(profile)) {
    throw new Error("Invalid DSH profile");
  }
  if (!isAbsoluteNpxExecutable(npxExecutable)) {
    throw new Error("Invalid npx executable");
  }
  return {
    command: npxExecutable,
    args: [
      "@deepseek-ai/dsh",
      "plugin",
      "--profile",
      profile,
      "add",
      "dsh-qingagent@latest",
    ],
    options: {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}

export function formatDshInstallCommand(profile: string): string {
  return `npx @deepseek-ai/dsh plugin --profile ${profile} add dsh-qingagent@latest`;
}

/**
 * 打包后的 Electron 主进程不依赖登录 shell PATH。先用系统查询工具解析；Windows
 * 再读取注册表里的真实系统/用户 PATH；最后检查 Node 版本管理器和常见安装目录。
 * 全程使用参数数组且关闭 shell。
 */
export function resolveNpxExecutable(
  options: NpxExecutableResolutionOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const lookup = options.lookup ?? defaultExecutableLookup;
  const fileExists = options.isFile ?? isFile;
  const readDirectory = options.readDirectory ?? readDirectoryNames;
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  const lookupRequests = platform === "win32"
    ? ["npx", "npx.cmd"].map((name) => ({
        command: env.SystemRoot
          ? path.win32.join(env.SystemRoot, "System32", "where.exe")
          : "where.exe",
        args: [name] as const,
      }))
    : [{ command: "which", args: ["npx"] as const }];

  for (const request of lookupRequests) {
    let output = "";
    try {
      output = lookup(request.command, request.args, {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      });
    } catch {
      continue;
    }
    for (const line of output.split(/\r?\n/u)) {
      const candidate = line.trim().replace(/^"|"$/gu, "");
      if (isUsableNpxPath(candidate, platform, fileExists)) return candidate;
    }
  }

  if (platform === "win32") {
    for (const directory of windowsRegistryPathDirectories(env, lookup)) {
      for (const executable of ["npx.cmd", "npx.exe", "npx"] as const) {
        const candidate = path.win32.join(directory, executable);
        if (isUsableNpxPath(candidate, platform, fileExists)) return candidate;
      }
    }
  }

  for (const candidate of commonNpxCandidates(platform, homeDir, env, readDirectory)) {
    if (pathApi.isAbsolute(candidate) && fileExists(candidate)) return candidate;
  }
  return null;
}

export async function installDshPlugin(
  profile: string,
  runtime: DshInstallRuntimeOptions = {},
): Promise<DshInstallResult> {
  const command = PROFILE_NAME_PATTERN.test(profile) ? formatDshInstallCommand(profile) : "";
  if (installRunning) {
    return failure(profile, command, "already-running", "已有安装任务正在执行");
  }

  const detection = detectDshInstallation(runtime.homeDir, { resolveNpx: () => null });
  const resolveNpx = runtime.resolveNpx ?? (() => resolveNpxExecutable({ homeDir: runtime.homeDir }));
  const npxExecutable = safeResolveNpx(resolveNpx);
  if (!npxExecutable) {
    return failure(
      profile,
      command,
      "npx-not-found",
      "未找到 Node/npx，请先安装 Node.js 20+",
    );
  }
  let invocation: DshInstallInvocation;
  try {
    invocation = buildDshInstallInvocation(
      profile,
      detection.profiles.map((item) => item.name),
      npxExecutable,
    );
  } catch {
    return failure(profile, command, "invalid-profile", "所选 profile 不在本机检测列表中");
  }

  installRunning = true;
  try {
    return await runInstallProcess(invocation, profile, {
      timeoutMs: runtime.timeoutMs ?? INSTALL_TIMEOUT_MS,
      spawnProcess: runtime.spawnProcess ?? spawn,
    });
  } finally {
    installRunning = false;
  }
}

function safeResolveNpx(resolveNpx: () => string | null): string | null {
  try {
    const executable = resolveNpx();
    return executable && isAbsoluteNpxExecutable(executable) ? executable : null;
  } catch {
    return null;
  }
}

function isAbsoluteNpxExecutable(filePath: string): boolean {
  const normalized = filePath.replace(/\\/gu, "/");
  const filename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath))
    && /^npx(?:\.cmd|\.exe)?$/iu.test(filename);
}

function isUsableNpxPath(
  filePath: string,
  platform: NodeJS.Platform,
  fileExists: (filePath: string) => boolean,
): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.isAbsolute(filePath) && isAbsoluteNpxExecutable(filePath) && fileExists(filePath);
}

function defaultExecutableLookup(
  command: string,
  args: readonly string[],
  options: NpxLookupOptions,
): string {
  return execFileSync(command, [...args], options);
}

function readDirectoryNames(directoryPath: string): string[] {
  try {
    return readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const WINDOWS_ENVIRONMENT_REGISTRY_KEYS = [
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  "HKCU\\Environment",
] as const;

function windowsRegistryPathDirectories(
  env: NodeJS.ProcessEnv,
  lookup: NonNullable<NpxExecutableResolutionOptions["lookup"]>,
): string[] {
  const regExecutable = env.SystemRoot
    ? path.win32.join(env.SystemRoot, "System32", "reg.exe")
    : "reg.exe";
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const registryKey of WINDOWS_ENVIRONMENT_REGISTRY_KEYS) {
    let output = "";
    try {
      output = lookup(regExecutable, ["query", registryKey, "/v", "Path"], {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      });
    } catch {
      continue;
    }
    for (const rawPath of parseWindowsRegistryPathValues(output)) {
      const expandedPath = expandWindowsEnvironmentVariables(rawPath, env);
      for (const rawDirectory of expandedPath.split(";")) {
        const directory = rawDirectory.trim().replace(/^"|"$/gu, "");
        if (!path.win32.isAbsolute(directory)) continue;
        const key = directory.toLocaleLowerCase("en-US");
        if (seen.has(key)) continue;
        seen.add(key);
        directories.push(directory);
      }
    }
  }
  return directories;
}

function parseWindowsRegistryPathValues(output: string): string[] {
  const values: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/iu.exec(line);
    if (match?.[1]) values.push(match[1]);
  }
  return values;
}

function expandWindowsEnvironmentVariables(
  value: string,
  env: NodeJS.ProcessEnv,
): string {
  const normalizedEnv = new Map<string, string>();
  for (const [name, envValue] of Object.entries(env)) {
    if (envValue !== undefined) normalizedEnv.set(name.toLocaleLowerCase("en-US"), envValue);
  }

  let expanded = value;
  for (let pass = 0; pass < 10; pass += 1) {
    const next = expanded.replace(/%([^%]+)%/gu, (reference, name: string) => (
      normalizedEnv.get(name.toLocaleLowerCase("en-US")) ?? reference
    ));
    if (next === expanded) break;
    expanded = next;
  }
  return expanded;
}

function commonNpxCandidates(
  platform: NodeJS.Platform,
  homeDir: string,
  env: NodeJS.ProcessEnv,
  readDirectory: (directoryPath: string) => string[],
): string[] {
  return platform === "win32"
    ? windowsNpxCandidates(homeDir, env, readDirectory)
    : posixNpxCandidates(homeDir, env, readDirectory);
}

function windowsNpxCandidates(
  homeDir: string,
  env: NodeJS.ProcessEnv,
  readDirectory: (directoryPath: string) => string[],
): string[] {
  const candidates: string[] = [];
  const add = (root: string | undefined, ...parts: string[]): void => {
    if (root) candidates.push(path.win32.join(root, ...parts));
  };
  add(env.NVM_SYMLINK, "npx.cmd");
  add(env.NVM_HOME, "npx.cmd");
  add(env.VOLTA_HOME, "bin", "npx.cmd");
  add(env.LOCALAPPDATA, "Volta", "bin", "npx.cmd");
  add(env.FNM_MULTISHELL_PATH, "npx.cmd");
  add(env.FNM_MULTISHELL_PATH, "bin", "npx.cmd");
  add(env.APPDATA, "npm", "npx.cmd");
  add(env.ProgramFiles, "nodejs", "npx.cmd");
  add(homeDir, "AppData", "Local", "Volta", "bin", "npx.cmd");

  const fnmRoots = [
    env.FNM_DIR ? path.win32.join(env.FNM_DIR, "node-versions") : null,
    env.APPDATA ? path.win32.join(env.APPDATA, "fnm", "node-versions") : null,
    env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, "fnm", "node-versions") : null,
  ].filter((root): root is string => Boolean(root));
  for (const root of fnmRoots) {
    for (const version of readDirectory(root)) {
      candidates.push(path.win32.join(root, version, "installation", "npx.cmd"));
    }
  }
  return candidates;
}

function posixNpxCandidates(
  homeDir: string,
  env: NodeJS.ProcessEnv,
  readDirectory: (directoryPath: string) => string[],
): string[] {
  const candidates: string[] = [];
  const add = (root: string | undefined, ...parts: string[]): void => {
    if (root) candidates.push(path.posix.join(root, ...parts));
  };
  add(env.NVM_BIN, "npx");
  add(env.VOLTA_HOME, "bin", "npx");
  add(homeDir, ".volta", "bin", "npx");
  add(env.FNM_MULTISHELL_PATH, "npx");
  add(env.FNM_MULTISHELL_PATH, "bin", "npx");
  candidates.push("/usr/local/bin/npx", "/opt/homebrew/bin/npx");

  const nvmRoot = path.posix.join(homeDir, ".nvm", "versions", "node");
  for (const version of readDirectory(nvmRoot)) {
    candidates.push(path.posix.join(nvmRoot, version, "bin", "npx"));
  }
  const fnmRoots = [
    env.FNM_DIR ? path.posix.join(env.FNM_DIR, "node-versions") : null,
    path.posix.join(homeDir, ".local", "share", "fnm", "node-versions"),
    path.posix.join(homeDir, ".fnm", "node-versions"),
    path.posix.join(homeDir, "Library", "Application Support", "fnm", "node-versions"),
  ].filter((root): root is string => Boolean(root));
  for (const root of fnmRoots) {
    for (const version of readDirectory(root)) {
      candidates.push(path.posix.join(root, version, "installation", "bin", "npx"));
    }
  }
  return candidates;
}

function readProfile(profilesDir: string, name: string): DshProfileSnapshot | null {
  const profileDir = path.join(profilesDir, name);
  const packageJson = readJsonObject(path.join(profileDir, "package.json"));
  if (!packageJson) return null;
  const dsh = asRecord(packageJson.dsh);
  const profile = asRecord(dsh?.profile);
  const bundles = Array.isArray(profile?.bundles)
    ? profile.bundles.filter((bundle): bundle is string => typeof bundle === "string")
    : [];
  const pluginPackage = readJsonObject(
    path.join(profileDir, "node_modules", "dsh-qingagent", "package.json"),
  );
  const pluginVersion = typeof pluginPackage?.version === "string" && pluginPackage.version.length > 0
    ? pluginPackage.version
    : null;
  return { name, bundles, pluginVersion };
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(directoryPath: string): boolean {
  try {
    return statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

async function runInstallProcess(
  invocation: DshInstallInvocation,
  profile: string,
  runtime: { timeoutMs: number; spawnProcess: typeof spawn },
): Promise<DshInstallResult> {
  const command = formatDshInstallCommand(profile);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;

    const finish = (result: DshInstallResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    try {
      child = runtime.spawnProcess(invocation.command, invocation.args, invocation.options);
    } catch (error) {
      resolve(failure(profile, command, "spawn-failed", errorSummary(error)));
      return;
    }

    const timeout = setTimeout(() => {
      child.kill();
      finish(failure(profile, command, "timed-out", "安装超过 180 秒，已停止等待", stdout));
    }, runtime.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.once("error", (error) => {
      finish(failure(profile, command, "spawn-failed", errorSummary(error), stdout));
    });
    child.once("close", (exitCode) => {
      const output = joinOutput(stdout, stderr);
      if (exitCode === 0) {
        finish({ ok: true, profile, command, output: output || "插件安装完成" });
        return;
      }
      finish(failure(
        profile,
        command,
        "exit-failed",
        stderr || `安装命令退出（code ${exitCode ?? "unknown"}）`,
        output,
      ));
    });
  });
}

function failure(
  profile: string,
  command: string,
  reason: Extract<DshInstallResult, { ok: false }>["reason"],
  stderr: string,
  output = "",
): DshInstallResult {
  return {
    ok: false,
    profile,
    command,
    reason,
    stderr: trimOutput(stderr),
    output: trimOutput(output),
  };
}

function appendOutput(current: string, next: string): string {
  return trimOutput(`${current}${stripAnsi(next)}`);
}

function trimOutput(value: string): string {
  return value.slice(-MAX_OUTPUT_CHARS).trim();
}

function joinOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function errorSummary(error: unknown): string {
  return error instanceof Error && error.message ? stripAnsi(error.message) : "无法启动安装命令";
}
