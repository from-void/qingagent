import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
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

export const WINDOWS_HIDE_PRELOAD_FILENAME = "hide-console.cjs";

export function renderWindowsNodeOptions(binDir: string): string {
  // Node 的 ParseNodeOptionsEnvVar 会把双引号内的反斜杠当转义符消费。Windows Node
  // 接受正斜杠路径，因此在写入 .cmd 前就固化绝对正斜杠路径，避免依赖 %~dp0 展开出的反斜杠。
  const preloadPath = win32
    .resolve(binDir, WINDOWS_HIDE_PRELOAD_FILENAME)
    .replace(/\\/g, "/");
  return `--require "${preloadPath}"`;
}

/**
 * Windows + Electron-as-node 专用预载:GUI 子系统进程没有控制台,它的 node 脚本再拉起
 * 控制台子进程(npm CLI 包装器普遍用裸 child_process,windowsHide 默认 false)时,
 * Windows 会分配**新的可见终端窗**(默认终端是 Windows Terminal 时尤其明显,每跑一条命令
 * 弹一个黑窗)。此预载给 child_process 全部入口强制 windowsHide(CREATE_NO_WINDOW),
 * 调用方显式传 false 时不覆盖。经 NODE_OPTIONS --require 注入,随环境变量传染整条子进程链。
 */
export function renderWindowsHidePreload(): string {
  return [
    '"use strict";',
    'if (process.platform === "win32") {',
    '  const cp = require("node:child_process");',
    '  const isOptions = (v) => v !== null && typeof v === "object" && !Array.isArray(v);',
    "  const withHide = (args) => {",
    "    const out = Array.prototype.slice.call(args);",
    "    for (let i = out.length - 1; i >= 0; i--) {",
    "      if (isOptions(out[i])) {",
    "        if (out[i].windowsHide === undefined) out[i] = Object.assign({}, out[i], { windowsHide: true });",
    "        return out;",
    "      }",
    "    }",
    '    const cb = out.findIndex((v) => typeof v === "function");',
    "    const opts = { windowsHide: true };",
    "    if (cb >= 0) out.splice(cb, 0, opts); else out.push(opts);",
    "    return out;",
    "  };",
    '  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {',
    "    const original = cp[name];",
    '    if (typeof original !== "function") continue;',
    "    cp[name] = function () { return original.apply(this, withHide(arguments)); };",
    "  }",
    "}",
    "",
  ].join("\n");
}

export function renderNodeRuntimeShim(options: NodeRuntimeShimOptions): RenderedNodeRuntimeShim {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const lines = ["@echo off"];
    if (options.electron) {
      lines.push(
        'set "ELECTRON_RUN_AS_NODE=1"',
        // set 不带外层引号:让 preload 路径两侧的引号进入变量值,cmd 对引号内的 & 等特殊字符
        // 按字面处理。这里只对 batch 的 % 做转义，最终 NODE_OPTIONS 仍保留原始绝对路径。
        `set NODE_OPTIONS=${renderWindowsNodeOptions(options.binDir ?? SANDBOX_BIN_DIR).replace(/%/g, "%%")}`,
      );
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
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && options.electron) {
    writeIfChanged(join(binDir, WINDOWS_HIDE_PRELOAD_FILENAME), renderWindowsHidePreload());
  }
  const rendered = renderNodeRuntimeShim(options);
  const shimPath = join(binDir, rendered.filename);
  writeIfChanged(shimPath, rendered.content);
  if (rendered.mode !== undefined) chmodSync(shimPath, rendered.mode);
  return shimPath;
}
