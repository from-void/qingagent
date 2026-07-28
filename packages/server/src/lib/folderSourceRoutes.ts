import type { Context } from "hono";
import { posix } from "node:path";

export const FOLDER_BRIDGE_OFFLINE_MESSAGE = "浏览器会话未连接到该文件夹，请断开后重新连接";

const HIDDEN_NAMES = new Set(["node_modules", ".git"]);

export function normalizeRelPath(raw: string | undefined): string | null {
  const value = raw ?? "";
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:\//.test(value)) {
    return null;
  }
  const parts = value.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

export function shouldHideEntry(name: string): boolean {
  return name.startsWith(".") || HIDDEN_NAMES.has(name) || name.includes("/") || name.includes("\\");
}

export function targetPath(mountPath: string, relPath: string): string {
  return relPath ? posix.join(mountPath, relPath) : mountPath;
}

export type FolderSourceErrorStatus = 400 | 403 | 404 | 413 | 502;

export function jsonError(c: Context, error: string, status: FolderSourceErrorStatus): Response {
  return c.json({ error, message: error }, status);
}

export function isBrowserBridgeOfflineError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "BrowserFolderBridgeError" &&
    (error as { code?: unknown }).code === "bridge_offline"
  );
}

export function publicFolderSourceErrorMessage(error: unknown): string {
  switch (browserBridgeErrorCode(error)) {
    case "bridge_offline":
      return FOLDER_BRIDGE_OFFLINE_MESSAGE;
    case "not_found":
      return "File or folder not found";
    case "permission_denied":
      return "Browser folder permission denied";
    case "too_large":
      return "File exceeds maxBytes";
    case "client_error":
      return "浏览器文件读取失败";
  }
  return error instanceof Error ? error.message : String(error);
}

function browserBridgeErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "BrowserFolderBridgeError") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(ENOENT|not_found|not found|no such file|does not exist)\b/i.test(message);
}

export function folderSourceErrorStatus(error: unknown): FolderSourceErrorStatus {
  switch (browserBridgeErrorCode(error)) {
    case "not_found":
      return 404;
    case "permission_denied":
      return 403;
    case "too_large":
      return 413;
    default:
      return isNotFoundError(error) ? 404 : 502;
  }
}
