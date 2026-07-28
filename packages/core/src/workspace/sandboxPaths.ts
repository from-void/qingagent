import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** 运行时数据根目录。Electron 主进程应设为 app.getPath("userData")/data;
 *  server/dev 默认 .qingagent/data。绝不能落在 ./uploads(公开文件服务根)下。 */
export const QINGAGENT_DATA_DIR = process.env.QINGAGENT_DATA_DIR
  ? resolve(process.env.QINGAGENT_DATA_DIR)
  : resolve(".qingagent/data");

function canonicalizeWithMissingTail(path: string): string {
  let cursor = resolve(path);
  const missingTail: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...missingTail.reverse());
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
      let unresolvedExistingEntry = false;
      try {
        lstatSync(cursor);
        unresolvedExistingEntry = true;
      } catch (lstatError) {
        const lstatCode =
          lstatError instanceof Error && "code" in lstatError ? String(lstatError.code) : "";
        if (lstatCode !== "ENOENT" && lstatCode !== "ENOTDIR") throw lstatError;
      }
      if (unresolvedExistingEntry) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingTail.push(basename(cursor));
      cursor = parent;
    }
  }
}

function isPathInside(child: string, parent: string): boolean {
  const relativePath = relative(parent, child);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function resolveSandboxPath(
  envName: "QINGAGENT_SANDBOX_DIR" | "QINGAGENT_SANDBOX_BIN_DIR",
  fallback: string,
): string {
  const configured = process.env[envName];
  if (!configured) return fallback;
  const resolved = resolve(configured);
  let isInsideDataDir = false;
  try {
    const canonicalDataDir = canonicalizeWithMissingTail(QINGAGENT_DATA_DIR);
    const canonicalConfigured = canonicalizeWithMissingTail(resolved);
    isInsideDataDir =
      isPathInside(resolved, QINGAGENT_DATA_DIR) &&
      isPathInside(canonicalConfigured, canonicalDataDir);
  } catch {
    // 启动期配置拒绝保持无感：无法可靠解析真实路径时仅告警并使用默认目录。
  }
  if (isInsideDataDir) return resolved;
  console.warn(`[sandboxPaths] ${envName} 必须位于 QINGAGENT_DATA_DIR 内，已回退默认目录`, {
    configuredPath: resolved,
    dataDir: QINGAGENT_DATA_DIR,
    fallbackPath: fallback,
  });
  return fallback;
}

/** 会话沙箱工作目录根；自定义目录必须位于 QINGAGENT_DATA_DIR 内。 */
export const SANDBOX_SESSIONS_BASE = resolveSandboxPath(
  "QINGAGENT_SANDBOX_DIR",
  join(QINGAGENT_DATA_DIR, "sessions"),
);

/** 产品级 CLI 安装目录；自定义目录必须位于 QINGAGENT_DATA_DIR 内。 */
export const SANDBOX_BIN_DIR = resolveSandboxPath(
  "QINGAGENT_SANDBOX_BIN_DIR",
  join(QINGAGENT_DATA_DIR, "bin"),
);
