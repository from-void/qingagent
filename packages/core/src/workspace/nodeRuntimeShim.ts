import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_BIN_DIR } from "./sandboxPaths.js";

export interface NodeRuntimeShimOptions {
  execPath: string;
  electron: boolean;
  binDir?: string;
  platform?: NodeJS.Platform;
}

export interface RenderedNodeRuntimeShim {
  filename: string;
  content: string;
  mode?: number;
}

export function isElectronRuntime(versions: NodeJS.ProcessVersions = process.versions): boolean {
  return typeof versions.electron === "string" && versions.electron.length > 0;
}

export function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function renderNodeRuntimeShim(options: NodeRuntimeShimOptions): RenderedNodeRuntimeShim {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const lines = ["@echo off"];
    if (options.electron) {
      lines.push('set "ELECTRON_RUN_AS_NODE=1"', 'set "NODE_OPTIONS="');
    }
    lines.push(`"${options.execPath.replace(/%/g, "%%")}" %*`);
    return { filename: "node.cmd", content: `${lines.join("\r\n")}\r\n` };
  }

  const lines = ["#!/bin/sh"];
  if (options.electron) {
    lines.push("export ELECTRON_RUN_AS_NODE=1", "unset NODE_OPTIONS");
  }
  lines.push(`exec ${posixSingleQuote(options.execPath)} "$@"`);
  return { filename: "node", content: `${lines.join("\n")}\n`, mode: 0o755 };
}

export function writeIfChanged(path: string, content: string): boolean {
  try {
    if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  } catch {
    // 读失败时直接重写,让调用方得到确定的 shim 内容。
  }
  writeFileSync(path, content);
  return true;
}

export function ensureNodeRuntimeShim(options: NodeRuntimeShimOptions): string {
  const binDir = options.binDir ?? SANDBOX_BIN_DIR;
  mkdirSync(binDir, { recursive: true });
  const rendered = renderNodeRuntimeShim(options);
  const shimPath = join(binDir, rendered.filename);
  writeIfChanged(shimPath, rendered.content);
  if (rendered.mode !== undefined) chmodSync(shimPath, rendered.mode);
  return shimPath;
}
