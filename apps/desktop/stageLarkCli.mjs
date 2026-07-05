import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * 构建期把飞书 lark-cli(@larksuite/cli,跨平台 Node CLI)暂存到 build/lark-cli,
 * electron-builder 通过 extraResources 拷进 Resources/lark-cli。运行时由 ensureLarkCliShim
 * 在沙箱 PATH 写 `lark-cli` 薄包装,经 Electron-as-Node 跑其 scripts/run.js。
 *
 * 用干净 prefix 做 `npm install --ignore-scripts`(跳过它的交互式 postinstall 安装向导,
 * run.js 仍可独立运行,已实测),得到 build/lark-cli/node_modules/{@larksuite/cli, @clack/*}。
 * 带版本缓存:已暂存且版本一致则跳过,避免每次构建都联网装。
 *
 * flag 关(QINGAGENT_BUNDLE_LARK_CLI=0/false/off/no)时只写占位文件,出「不含飞书」的瘦包。
 */

export const LARK_CLI_VERSION = "1.0.53";
export const LARK_CLI_RUN_JS_RELATIVE = join(
  "node_modules",
  "@larksuite",
  "cli",
  "scripts",
  "run.js",
);

export function isBundleLarkCliEnabled(value = process.env.QINGAGENT_BUNDLE_LARK_CLI) {
  // 默认 ON(全能力包);仅显式假值关闭。
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") return true;
  return !["0", "false", "off", "no"].includes(v);
}

function stagedVersion(stageDir) {
  try {
    const pkg = JSON.parse(
      readFileSync(join(stageDir, "node_modules", "@larksuite", "cli", "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function stageLarkCli({
  cwd = process.cwd(),
  bundle = isBundleLarkCliEnabled(),
  version = LARK_CLI_VERSION,
} = {}) {
  const stageDir = resolve(cwd, "build/lark-cli");

  if (!bundle) {
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(
      join(stageDir, "DISABLED.txt"),
      "lark-cli not bundled. Rebuild with QINGAGENT_BUNDLE_LARK_CLI=1 to include Feishu CLI.\n",
    );
    return { bundled: false, stageDir, runJsRelative: LARK_CLI_RUN_JS_RELATIVE };
  }

  // 版本缓存命中即跳过(避免每次构建都联网 npm install)。
  if (existsSync(join(stageDir, LARK_CLI_RUN_JS_RELATIVE)) && stagedVersion(stageDir) === version) {
    return { bundled: true, stageDir, runJsRelative: LARK_CLI_RUN_JS_RELATIVE, cached: true };
  }

  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(
    join(stageDir, "package.json"),
    `${JSON.stringify(
      {
        name: "qingagent-lark-cli-bundle",
        private: true,
        version: "0.0.0",
        dependencies: { "@larksuite/cli": version },
      },
      null,
      2,
    )}\n`,
  );
  // --ignore-scripts:跳过 @larksuite/cli 的交互式 postinstall(install-wizard),否则会卡构建;
  // run.js 不依赖该 postinstall,可独立运行(已实测)。--omit=dev/--no-audit/--no-fund 减体积提速。
  // Windows 上 npm 是 npm.cmd,execFileSync 无 shell 找不到裸 "npm"(ENOENT);Linux/mac 直接可执行。
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(
    npmCmd,
    ["install", "--prefix", stageDir, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { stdio: "inherit" },
  );
  if (!existsSync(join(stageDir, LARK_CLI_RUN_JS_RELATIVE))) {
    throw new Error("lark-cli 暂存失败:缺 run.js");
  }
  return { bundled: true, stageDir, runJsRelative: LARK_CLI_RUN_JS_RELATIVE };
}
