import { chmodSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { posixSingleQuote, writeIfChanged } from "./nodeRuntimeShim.js";

/**
 * qa CLI 用户终端 shim:把随包的 qa-cli(Resources/qa-cli/cli.mjs)暴露成用户终端里的
 * `qa` 命令,供 Claude Code / Codex 等外部 Agent 在应用之外调用。
 *
 * 与 larkCliShim(沙箱 PATH,供应用内技能)不同,这里写的是**用户可见**的
 * ~/.qingagent/bin/qa:用 ELECTRON_RUN_AS_NODE=1 借应用自带的 Electron 当 Node 运行时,
 * 用户机器不需要装 Node。mac/linux 上尽力往 /usr/local/bin 建 symlink(默认 PATH 内,
 * 无权限则跳过不打扰);shim 每次启动重写,应用挪位置后自愈。
 */
export interface QaCliUserShimOptions {
  /** 应用可执行文件绝对路径(process.execPath),ELECTRON_RUN_AS_NODE=1 下当 Node 用。 */
  execPath: string;
  /** 随包 CLI 入口绝对路径(打包后:Resources/qa-cli/cli.mjs)。 */
  cliJsPath: string;
  /** shim 落盘目录,默认 ~/.qingagent/bin。 */
  binDir?: string;
  /**
   * posix 下尝试建 `qa` symlink 的目录;默认 /usr/local/bin(darwin/linux)。
   * 传 null 显式关闭(测试或不想动系统目录时)。
   */
  symlinkDir?: string | null;
  platform?: NodeJS.Platform;
  /** PATH 环境变量(默认 process.env.PATH),用于判断 shim 是否已可直接调用。 */
  pathEnv?: string;
}

export interface RenderedQaCliUserShim {
  filename: string;
  content: string;
  mode?: number;
}

export interface EnsuredQaCliUserShim {
  shimPath: string;
  /** 成功建立(或已存在且指向本 shim)的 symlink 路径;未建立为 undefined。 */
  symlinkPath?: string;
  /** shim(或 symlink)所在目录是否已在 PATH 上——false 时调用方应提示用户补 PATH。 */
  onPath: boolean;
}

export function renderQaCliUserShim(options: QaCliUserShimOptions): RenderedQaCliUserShim {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const exec = options.execPath.replace(/%/g, "%%");
    const cli = options.cliJsPath.replace(/%/g, "%%");
    const lines = [
      "@echo off",
      "setlocal",
      "set ELECTRON_RUN_AS_NODE=1",
      `"${exec}" "${cli}" %*`,
      "endlocal",
    ];
    return { filename: "qa.cmd", content: `${lines.join("\r\n")}\r\n` };
  }
  const lines = [
    "#!/bin/sh",
    `ELECTRON_RUN_AS_NODE=1 exec ${posixSingleQuote(options.execPath)} ${posixSingleQuote(options.cliJsPath)} "$@"`,
  ];
  return { filename: "qa", content: `${lines.join("\n")}\n`, mode: 0o755 };
}

/** symlink 现状:missing=可建;ours=已指向本 shim;foreign=别人的文件/链接,不动。 */
function classifySymlink(linkPath: string, shimPath: string): "missing" | "ours" | "foreign" {
  let st;
  try {
    st = lstatSync(linkPath);
  } catch {
    return "missing";
  }
  if (!st.isSymbolicLink()) return "foreign";
  try {
    const target = readlinkSync(linkPath);
    if (target === shimPath) return "ours";
    // 指向旧版 .qingagent/bin 的链接视为我们的,允许原子重指
    if (target.includes(`${join(".qingagent", "bin")}`)) return "ours";
  } catch {
    return "foreign";
  }
  return "foreign";
}

function isDirOnPath(dir: string, pathEnv: string | undefined): boolean {
  if (!pathEnv) return false;
  return pathEnv.split(delimiter).some((p) => p === dir);
}

export function ensureQaCliUserShim(options: QaCliUserShimOptions): EnsuredQaCliUserShim {
  const platform = options.platform ?? process.platform;
  const binDir = options.binDir ?? join(homedir(), ".qingagent", "bin");
  mkdirSync(binDir, { recursive: true });
  const rendered = renderQaCliUserShim(options);
  const shimPath = join(binDir, rendered.filename);
  writeIfChanged(shimPath, rendered.content);
  if (rendered.mode !== undefined) chmodSync(shimPath, rendered.mode);

  const pathEnv = options.pathEnv ?? process.env.PATH;
  let symlinkPath: string | undefined;
  if (platform !== "win32") {
    const symlinkDir =
      options.symlinkDir === undefined ? "/usr/local/bin" : options.symlinkDir;
    if (symlinkDir) {
      const linkPath = join(symlinkDir, "qa");
      const state = classifySymlink(linkPath, shimPath);
      try {
        if (state === "missing") {
          symlinkSync(shimPath, linkPath);
          symlinkPath = linkPath;
        } else if (state === "ours") {
          if (readlinkSync(linkPath) !== shimPath) {
            unlinkSync(linkPath);
            symlinkSync(shimPath, linkPath);
          }
          symlinkPath = linkPath;
        }
        // foreign:用户自己的 qa,绝不覆盖
      } catch {
        // 无权限(stock macOS 的 /usr/local/bin 属 root)等一律静默——binDir shim 仍在
      }
    }
  }

  const onPath =
    (symlinkPath !== undefined && isDirOnPath(dirname(symlinkPath), pathEnv)) ||
    isDirOnPath(binDir, pathEnv);
  return { shimPath, symlinkPath, onPath };
}
