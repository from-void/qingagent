import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { SANDBOX_BIN_DIR, SANDBOX_NODE_RUNTIME_DIR } from "./sandboxPaths.js";

/**
 * 产品自带 Node 运行时 shim。
 *
 * 桌面端不随包带 Node,而是让主程序以 Electron-as-Node 模式扮演 `node`,给产品自带的
 * Node CLI(如随包 lark-cli)与技能脚本提供运行时。
 *
 * **边界(0729 真机病根)**:这个 shim 只能作为**产品自带 CLI 显式指定的运行时**,
 * 或宿主完全没有 Node 时的兜底,绝不能以通用名 `node` 常驻 PATH 最前——那样所有
 * `#!/usr/bin/env node` 的宿主 CLI 都会被主程序拉起,系统凭据存储按调用程序身份判权,
 * 用户在终端里正常可用的登录态就此读不出来。落地位置见 SANDBOX_NODE_RUNTIME_DIR,
 * PATH 站位见 resolveNodeRuntimePathPlacement。
 */
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
        `set NODE_OPTIONS=${renderWindowsNodeOptions(options.binDir ?? SANDBOX_NODE_RUNTIME_DIR).replace(/%/g, "%%")}`,
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

/**
 * 历史上被写进 PATH 目录(SANDBOX_BIN_DIR)的 Node 运行时残留文件名。
 * 这些文件一旦留在 PATH 最前的目录里,就会继续劫持宿主的 `node`——**换成新版程序、
 * 甚至改配置跳过 shim 生成都治不好**,必须当作升级迁移的一部分主动删掉。
 */
export const LEGACY_PATH_NODE_SHIM_FILENAMES = [
  "node",
  "node.cmd",
  WINDOWS_HIDE_PRELOAD_FILENAME,
] as const;

/**
 * 清除遗留在 PATH 目录里的 Node shim。返回真正删掉的文件名。
 *
 * 只删我们自己生成的这三个固定文件名,且只在**产品 CLI 目录**里删——绝不碰
 * node-runtime 子目录(那是新家),更不碰宿主任何位置。删除失败静默跳过:
 * 迁移动作不该让客户端启动失败。
 */
export function pruneLegacyNodeRuntimeShims(binDir: string = SANDBOX_BIN_DIR): string[] {
  const removed: string[] = [];
  for (const filename of LEGACY_PATH_NODE_SHIM_FILENAMES) {
    const target = join(binDir, filename);
    try {
      if (!existsSync(target)) continue;
      rmSync(target, { force: true });
      removed.push(filename);
    } catch {
      // 删不掉(权限/占用)不该拖垮启动;PATH 策略侧仍会把宿主 Node 排在前面兜住。
    }
  }
  return removed;
}

export function ensureNodeRuntimeShim(options: NodeRuntimeShimOptions): string {
  const binDir = options.binDir ?? SANDBOX_NODE_RUNTIME_DIR;
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
