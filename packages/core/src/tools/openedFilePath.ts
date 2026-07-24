import { realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface VerifyOpenedFilePathOptions {
  /** 打开前已授权的规范路径；fd 实际路径必须仍指向同一路径。 */
  expectedPath: string;
  /** 可选授权根；资料库读取还要求 fd 实际路径位于该根内。 */
  allowedRoot?: string;
  /** parseFile 等调用方可追加敏感路径黑名单。 */
  validatePath?: (actualPath: string) => boolean;
  /** 仅供跨平台策略单测注入；生产使用 process.platform。 */
  platform?: NodeJS.Platform;
}

function normalizeForCompare(path: string, platform: NodeJS.Platform): string {
  const normalized = resolve(path);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return normalizeForCompare(left, platform) === normalizeForCompare(right, platform);
}

function isPathInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const normalizedChild = normalizeForCompare(child, platform);
  const normalizedParent = normalizeForCompare(parent, platform);
  const rel = relative(normalizedParent, normalizedChild);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 打开后从 fd 命名空间反查内核实际持有的文件，再复核授权路径。
 *
 * Windows 的 Node FileHandle 没有等价于 GetFinalPathNameByHandle 的 API；仅重新
 * realpath 原字符串仍存在父目录 reparse point 竞态，因此该平台明确 fail-closed。
 * 非 Linux POSIX 尝试 /dev/fd；若系统没有可反查为真实文件的 fd 文件系统同样拒绝。
 */
export async function verifyOpenedFilePath(
  fileHandle: FileHandle,
  options: VerifyOpenedFilePathOptions,
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw new Error("secure_fd_path_unavailable: Windows host file reads are disabled");
  }

  const fdRoot = platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  const fdReference = `${fdRoot}/${fileHandle.fd}`;
  const actualPath = await realpath(fdReference);
  if (!isAbsolute(actualPath) || samePath(actualPath, fdReference, platform)) {
    throw new Error("secure_fd_path_unavailable: fd path did not resolve to a host file");
  }
  if (!samePath(actualPath, options.expectedPath, platform)) {
    throw new Error("opened_file_path_mismatch: file changed after authorization");
  }
  if (options.allowedRoot && !isPathInside(actualPath, options.allowedRoot, platform)) {
    throw new Error("opened_file_path_outside_root: file escaped the authorized root");
  }
  if (options.validatePath && !options.validatePath(actualPath)) {
    throw new Error("opened_file_path_denied: actual file path is not allowed");
  }
  return actualPath;
}
