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

/**
 * 产品自带 Node 运行时(桌面是 Electron-as-Node 的 `node` shim)目录。
 *
 * 必须与 SANDBOX_BIN_DIR **分开**:产品 CLI 目录常驻 PATH 最前,把一个通用名 `node`
 * 放进去等于**无差别劫持所有 `#!/usr/bin/env node` 的宿主 CLI**——宿主 CLI 会被我们的
 * 主程序(而不是用户终端里的 Node)拉起,系统凭据存储看到的调用方身份随之改变,用户在
 * 终端里本来好好的登录态就读不出来了(0729 真机病根)。
 *
 * 拆成 bin 的子目录而不是另起一个顶层目录:读墙/沙箱早已把 bin 整棵树放行,子目录天然继承,
 * 不引入任何新的放行面。它是否进 PATH、进 PATH 的哪一头,由 resolveNodeRuntimePathPlacement 决定。
 */
export const SANDBOX_NODE_RUNTIME_DIR = join(SANDBOX_BIN_DIR, "node-runtime");
