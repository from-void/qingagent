import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

const STORAGE_STATE_FILE = ".qingagent-browser-state.json";
const PROFILE_DIRECTORY = ".qingagent-browser-profile";

type LegacyDirectoryOptions = {
  cwd?: string;
  execPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

export type BrowserDataMigrationFailure = {
  path: string;
  reason: string;
};

export type BrowserDataMigrationResult = {
  migrated: string[];
  cleaned: string[];
  discarded: string[];
  failures: BrowserDataMigrationFailure[];
};

type BrowserDataKind = "file" | "directory";

function pathKey(value: string, platform: NodeJS.Platform): string {
  const resolved =
    platform === "win32" ? path.win32.resolve(value) : path.resolve(value);
  const root =
    platform === "win32" ? path.win32.parse(resolved).root : path.parse(resolved).root;
  const withoutTrailingSeparator =
    resolved === root ? root : resolved.replace(/[\\/]+$/, "");
  return platform === "win32"
    ? withoutTrailingSeparator.toLowerCase()
    : withoutTrailingSeparator;
}

/**
 * 旧实现只看 process.cwd()；除本次 cwd 外，也检查安装目录及 Windows 快捷方式常见的系统 cwd。
 * 候选只用于拼接两个固定的 qingagent 敏感文件名，不扫描或删除其它内容。
 */
export function legacyAgentBrowserDirectories(
  options: LegacyDirectoryOptions = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const candidates = [
    options.cwd ?? process.cwd(),
    path.dirname(options.execPath ?? process.execPath),
    ...(platform === "win32" ? [env.SystemRoot, env.WINDIR] : []),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    const key = pathKey(value, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExpectedKind(source: string, kind: BrowserDataKind): boolean {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) return false;
  return kind === "file" ? stat.isFile() : stat.isDirectory();
}

function removeSensitivePath(source: string, kind: BrowserDataKind): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink() || kind === "file") {
    unlinkSync(source);
    return;
  }
  rmSync(source, { recursive: true, force: false });
}

function restrictTargetPermissions(target: string, kind: BrowserDataKind): void {
  chmodSync(target, kind === "file" ? 0o600 : 0o700);
}

function copyViaTemporaryPath(
  source: string,
  target: string,
  kind: BrowserDataKind,
): void {
  const temporary = `${target}.migration-${process.pid}-${randomUUID()}`;
  try {
    if (kind === "file") {
      copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    } else {
      cpSync(source, temporary, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    }
    restrictTargetPermissions(temporary, kind);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function cleanInsteadOfMigrate(
  source: string,
  kind: BrowserDataKind,
  migrationError: unknown,
  result: BrowserDataMigrationResult,
): void {
  try {
    removeSensitivePath(source, kind);
    result.discarded.push(source);
  } catch (cleanupError) {
    result.failures.push({
      path: source,
      reason: `迁移失败(${errorReason(migrationError)})；清理失败(${errorReason(cleanupError)})`,
    });
  }
}

function migrateOne(
  source: string,
  target: string,
  kind: BrowserDataKind,
  result: BrowserDataMigrationResult,
  platform: NodeJS.Platform,
): void {
  if (!existsSync(source) || pathKey(source, platform) === pathKey(target, platform)) return;
  try {
    if (!isExpectedKind(source, kind)) {
      throw new Error(
        kind === "file" ? "旧登录态不是普通文件" : "旧浏览器 profile 不是普通目录",
      );
    }
  } catch (error) {
    result.failures.push({ path: source, reason: errorReason(error) });
    return;
  }

  if (existsSync(target)) {
    try {
      removeSensitivePath(source, kind);
      result.cleaned.push(source);
    } catch (error) {
      result.failures.push({ path: source, reason: errorReason(error) });
    }
    return;
  }

  try {
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  } catch (error) {
    cleanInsteadOfMigrate(source, kind, error, result);
    return;
  }

  let renamed = false;
  try {
    renameSync(source, target);
    renamed = true;
  } catch {
    // Windows 系统目录与 userData 可能跨卷；回退到同目标目录临时副本，再原子改名。
  }
  if (renamed) {
    try {
      restrictTargetPermissions(target, kind);
    } catch (error) {
      result.failures.push({ path: target, reason: errorReason(error) });
    }
    result.migrated.push(source);
    return;
  }

  try {
    copyViaTemporaryPath(source, target, kind);
  } catch (error) {
    // 安全优先：无法保留登录态时仍清理旧敏感副本，避免继续遗留在系统/安装目录。
    cleanInsteadOfMigrate(source, kind, error, result);
    return;
  }
  try {
    removeSensitivePath(source, kind);
  } catch (error) {
    result.failures.push({ path: source, reason: errorReason(error) });
  }
  result.migrated.push(source);
}

export function migrateLegacyAgentBrowserData(options: {
  legacyDirectories: string[];
  storageStatePath: string;
  profileDir: string;
  platform?: NodeJS.Platform;
}): BrowserDataMigrationResult {
  const result: BrowserDataMigrationResult = {
    migrated: [],
    cleaned: [],
    discarded: [],
    failures: [],
  };
  const platform = options.platform ?? process.platform;
  const seen = new Set<string>();
  for (const legacyDirectory of options.legacyDirectories) {
    const key = pathKey(legacyDirectory, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    migrateOne(
      path.join(legacyDirectory, STORAGE_STATE_FILE),
      options.storageStatePath,
      "file",
      result,
      platform,
    );
    migrateOne(
      path.join(legacyDirectory, PROFILE_DIRECTORY),
      options.profileDir,
      "directory",
      result,
      platform,
    );
  }
  return result;
}
