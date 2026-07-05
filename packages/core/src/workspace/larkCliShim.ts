import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_BIN_DIR } from "./sessionWorkspace.js";
import { posixSingleQuote, writeIfChanged } from "./nodeRuntimeShim.js";

/**
 * 飞书 lark-cli 沙箱 shim:把随包的 @larksuite/cli(Node CLI,bin=scripts/run.js)暴露成
 * 沙箱 PATH 上的 `lark-cli` 命令。镜像 nodeRuntimeShim 的做法——往 SANDBOX_BIN_DIR 写一个
 * 经 node(桌面是 Electron-as-Node 的 node shim)运行 run.js 的薄包装。
 *
 * 背景:lark-cli 跨平台(不是平台二进制),只 1 个依赖。桌面端随包带 @larksuite/cli 到
 * Resources/lark-cli,首启写此 shim,沙箱即可直接 `lark-cli ...`。HOME/配置走宿主真实 HOME
 * (沙箱透传),lark-cli 写真实 ~/.lark-cli,与用户电脑上已有飞书登录共用(用户已选此口径)。
 */
export interface LarkCliShimOptions {
  /** 随包 @larksuite/cli 的 scripts/run.js 绝对路径(打包后:Resources/lark-cli/scripts/run.js)。 */
  runJsPath: string;
  /** node 运行时绝对路径:桌面传 ensureNodeRuntimeShim 写出的 node shim(它会设 ELECTRON_RUN_AS_NODE)。 */
  nodePath: string;
  binDir?: string;
  platform?: NodeJS.Platform;
}

export interface RenderedLarkCliShim {
  filename: string;
  content: string;
  mode?: number;
}

export function renderLarkCliShim(options: LarkCliShimOptions): RenderedLarkCliShim {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const node = options.nodePath.replace(/%/g, "%%");
    const run = options.runJsPath.replace(/%/g, "%%");
    // call 调 node.cmd(node shim),再把参数透传给 run.js。
    const lines = ["@echo off", `call "${node}" "${run}" %*`];
    return { filename: "lark-cli.cmd", content: `${lines.join("\r\n")}\r\n` };
  }
  const lines = [
    "#!/bin/sh",
    `exec ${posixSingleQuote(options.nodePath)} ${posixSingleQuote(options.runJsPath)} "$@"`,
  ];
  return { filename: "lark-cli", content: `${lines.join("\n")}\n`, mode: 0o755 };
}

export function ensureLarkCliShim(options: LarkCliShimOptions): string {
  const binDir = options.binDir ?? SANDBOX_BIN_DIR;
  mkdirSync(binDir, { recursive: true });
  const rendered = renderLarkCliShim(options);
  const shimPath = join(binDir, rendered.filename);
  writeIfChanged(shimPath, rendered.content);
  if (rendered.mode !== undefined) chmodSync(shimPath, rendered.mode);
  return shimPath;
}
