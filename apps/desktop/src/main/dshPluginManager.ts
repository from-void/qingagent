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

export interface NpxSpawnInvocation {
  command: string;
  prefixArgs: string[];
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
  resolveNpx?: () => NpxSpawnInvocation | null;
}

export interface DshInstallRuntimeOptions {
  homeDir?: string;
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
  resolveNpx?: () => NpxSpawnInvocation | null;
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
  npxInvocation: NpxSpawnInvocation,
): DshInstallInvocation {
  if (!PROFILE_NAME_PATTERN.test(profile) || !detectedProfiles.includes(profile)) {
    throw new Error("Invalid DSH profile");
  }
  if (!isSafeNpxInvocation(npxInvocation)) {
    throw new Error("Invalid npx invocation");
  }
  return {
    command: npxInvocation.command,
    args: [
      ...npxInvocation.prefixArgs,
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
): NpxSpawnInvocation | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const lookup = options.lookup ?? defaultExecutableLookup;
  const fileExists = options.isFile ?? isFile;
  const readDirectory = options.readDirectory ?? readDirectoryNames;

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
      const directory = npxLookupResultDirectory(candidate, platform);
      if (!directory) continue;
      const invocation = resolveNpxFromDirectory(directory, platform, env, fileExists);
      if (invocation) return invocation;
    }
  }

  if (platform === "win32") {
    for (const directory of windowsRegistryPathDirectories(env, lookup)) {
      const invocation = resolveNpxFromDirectory(directory, platform, env, fileExists);
      if (invocation) return invocation;
    }
  }

  for (const directory of commonNpxDirectories(platform, homeDir, env, readDirectory)) {
    const invocation = resolveNpxFromDirectory(directory, platform, env, fileExists);
    if (invocation) return invocation;
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
  const npxInvocation = safeResolveNpx(resolveNpx);
  if (!npxInvocation) {
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
      npxInvocation,
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

function safeResolveNpx(
  resolveNpx: () => NpxSpawnInvocation | null,
): NpxSpawnInvocation | null {
  try {
    const invocation = resolveNpx();
    return invocation && isSafeNpxInvocation(invocation) ? invocation : null;
  } catch {
    return null;
  }
}

function isSafeNpxInvocation(value: NpxSpawnInvocation): boolean {
  if (!value || typeof value.command !== "string" || !Array.isArray(value.prefixArgs)) {
    return false;
  }
  if (!value.prefixArgs.every((argument) => typeof argument === "string")) return false;

  const isWindowsCommand = isWindowsAbsolutePath(value.command);
  const isPosixCommand = !isWindowsCommand && path.posix.isAbsolute(value.command);
  if (!isWindowsCommand && !isPosixCommand) return false;

  if (value.prefixArgs.length === 0) {
    return isWindowsCommand
      ? path.win32.basename(value.command).toLocaleLowerCase("en-US") === "npx.exe"
      : path.posix.basename(value.command) === "npx";
  }

  const commandName = isWindowsCommand
    ? path.win32.basename(value.command).toLocaleLowerCase("en-US")
    : path.posix.basename(value.command);
  if (commandName === (isWindowsCommand ? "node.exe" : "node")) {
    const cliPath = value.prefixArgs[0] ?? "";
    return value.prefixArgs.length === 1
      && (isWindowsCommand ? isWindowsAbsolutePath(cliPath) : path.posix.isAbsolute(cliPath))
      && /(?:^|[\\/])npx-cli\.js$/u.test(cliPath);
  }

  return isWindowsCommand
    && commandName === "cmd.exe"
    && value.prefixArgs.length === 4
    && value.prefixArgs[0] === "/d"
    && value.prefixArgs[1] === "/s"
    && value.prefixArgs[2] === "/c"
    && isWindowsAbsolutePath(value.prefixArgs[3] ?? "")
    && path.win32.basename(value.prefixArgs[3] ?? "").toLocaleLowerCase("en-US") === "npx.cmd";
}

function isWindowsAbsolutePath(filePath: string): boolean {
  return path.win32.isAbsolute(filePath) && /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(filePath);
}

function isAbsoluteNpxExecutable(
  filePath: string,
  platform: NodeJS.Platform,
): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32" ? !isWindowsAbsolutePath(filePath) : !pathApi.isAbsolute(filePath)) {
    return false;
  }
  const filename = pathApi.basename(filePath);
  return platform === "win32"
    ? /^npx\.(?:cmd|exe)$/iu.test(filename)
    : filename === "npx";
}

function isUsableNpxPath(
  filePath: string,
  platform: NodeJS.Platform,
  fileExists: (filePath: string) => boolean,
): boolean {
  return isAbsoluteNpxExecutable(filePath, platform) && fileExists(filePath);
}

function npxLookupResultDirectory(
  filePath: string,
  platform: NodeJS.Platform,
): string | null {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32" ? !isWindowsAbsolutePath(filePath) : !pathApi.isAbsolute(filePath)) {
    return null;
  }
  const filename = pathApi.basename(filePath);
  const isNpxLookupResult = platform === "win32"
    ? /^npx(?:\.cmd|\.exe)?$/iu.test(filename)
    : filename === "npx";
  if (!isNpxLookupResult) return null;

  // Windows 的无扩展名 npx 仅可作为 where.exe 提供的目录线索，绝不作为可执行调用返回。
  return pathApi.dirname(filePath);
}

function resolveNpxFromDirectory(
  directory: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  fileExists: (filePath: string) => boolean,
): NpxSpawnInvocation | null {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32" ? !isWindowsAbsolutePath(directory) : !pathApi.isAbsolute(directory)) {
    return null;
  }

  const nodeExecutable = pathApi.join(directory, platform === "win32" ? "node.exe" : "node");
  const cliCandidates = platform === "win32"
    ? [path.win32.join(directory, "node_modules", "npm", "bin", "npx-cli.js")]
    : [
        path.posix.join(directory, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
        path.posix.join(directory, "node_modules", "npm", "bin", "npx-cli.js"),
      ];
  if (fileExists(nodeExecutable)) {
    const npxCli = cliCandidates.find((candidate) => fileExists(candidate));
    if (npxCli) return { command: nodeExecutable, prefixArgs: [npxCli] };
  }

  const nativeNpx = pathApi.join(directory, platform === "win32" ? "npx.exe" : "npx");
  if (isUsableNpxPath(nativeNpx, platform, fileExists)) {
    return { command: nativeNpx, prefixArgs: [] };
  }

  if (platform !== "win32") return null;
  const npxCmd = path.win32.join(directory, "npx.cmd");
  const systemRoot = env.SystemRoot ?? env.WINDIR;
  if (!systemRoot || !isWindowsAbsolutePath(systemRoot)
    || !isUsableNpxPath(npxCmd, platform, fileExists)) {
    return null;
  }

  // Node 20.12+/22 无法在 shell:false 下直接 spawn .cmd；显式调用系统 cmd.exe，
  // 仍使用参数数组与 shell:false，避免退回字符串命令行或启用 shell。
  return {
    command: path.win32.join(systemRoot, "System32", "cmd.exe"),
    prefixArgs: ["/d", "/s", "/c", npxCmd],
  };
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

function commonNpxDirectories(
  platform: NodeJS.Platform,
  homeDir: string,
  env: NodeJS.ProcessEnv,
  readDirectory: (directoryPath: string) => string[],
): string[] {
  return platform === "win32"
    ? windowsNpxDirectories(homeDir, env, readDirectory)
    : posixNpxDirectories(homeDir, env, readDirectory);
}

function windowsNpxDirectories(
  homeDir: string,
  env: NodeJS.ProcessEnv,
  readDirectory: (directoryPath: string) => string[],
): string[] {
  const directories: string[] = [];
  const add = (root: string | undefined, ...parts: string[]): void => {
    if (root) directories.push(path.win32.join(root, ...parts));
  };
  add(env.NVM_SYMLINK);
  add(env.NVM_HOME);
  add(env.VOLTA_HOME, "bin");
  add(env.LOCALAPPDATA, "Volta", "bin");
  add(env.FNM_MULTISHELL_PATH);
  add(env.FNM_MULTISHELL_PATH, "bin");
  add(env.APPDATA, "npm");
  add(env.ProgramFiles, "nodejs");
  add(homeDir, "AppData", "Local", "Volta", "bin");

  const fnmRoots = [
    env.FNM_DIR ? path.win32.join(env.FNM_DIR, "node-versions") : null,
    env.APPDATA ? path.win32.join(env.APPDATA, "fnm", "node-versions") : null,
    env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, "fnm", "node-versions") : null,
  ].filter((root): root is string => Boolean(root));
  for (const root of fnmRoots) {
    for (const version of readDirectory(root)) {
      directories.push(path.win32.join(root, version, "installation"));
    }
  }
  return directories;
}

function posixNpxDirectories(
  homeDir: string,
  env: NodeJS.ProcessEnv,
  readDirectory: (directoryPath: string) => string[],
): string[] {
  const directories: string[] = [];
  const add = (root: string | undefined, ...parts: string[]): void => {
    if (root) directories.push(path.posix.join(root, ...parts));
  };
  add(env.NVM_BIN);
  add(env.VOLTA_HOME, "bin");
  add(homeDir, ".volta", "bin");
  add(env.FNM_MULTISHELL_PATH);
  add(env.FNM_MULTISHELL_PATH, "bin");
  directories.push("/usr/local/bin", "/opt/homebrew/bin");

  const nvmRoot = path.posix.join(homeDir, ".nvm", "versions", "node");
  for (const version of readDirectory(nvmRoot)) {
    directories.push(path.posix.join(nvmRoot, version, "bin"));
  }
  const fnmRoots = [
    env.FNM_DIR ? path.posix.join(env.FNM_DIR, "node-versions") : null,
    path.posix.join(homeDir, ".local", "share", "fnm", "node-versions"),
    path.posix.join(homeDir, ".fnm", "node-versions"),
    path.posix.join(homeDir, "Library", "Application Support", "fnm", "node-versions"),
  ].filter((root): root is string => Boolean(root));
  for (const root of fnmRoots) {
    for (const version of readDirectory(root)) {
      directories.push(path.posix.join(root, version, "installation", "bin"));
    }
  }
  return directories;
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
