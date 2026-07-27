import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { REQUIRED_PYODIDE_RUNTIME_FILES } from "./buildPyodideStage.mjs";
import { LARK_CLI_RUN_JS_RELATIVE } from "./stageLarkCli.mjs";

/**
 * 暂存资源完整时，断言 electron-builder 已将它们复制进最终应用目录。
 * 瘦包暂存目录只有 DISABLED.txt，不触发断言。
 */
export function assertPackagedResources({ projectDir, resourcesDir }) {
  const errors = [];

  const stagedLarkRunJs = resolve(projectDir, "build/lark-cli", LARK_CLI_RUN_JS_RELATIVE);
  if (existsSync(stagedLarkRunJs)) {
    const packagedLarkRunJs = resolve(resourcesDir, "lark-cli", LARK_CLI_RUN_JS_RELATIVE);
    if (!existsSync(packagedLarkRunJs)) {
      errors.push(`飞书 lark-cli 打包缺失:${packagedLarkRunJs}`);
    }
  }

  const stagedPyodideDir = resolve(projectDir, "build/pyodide");
  const pyodideStaged = REQUIRED_PYODIDE_RUNTIME_FILES.every((file) =>
    existsSync(join(stagedPyodideDir, file)),
  );
  if (pyodideStaged) {
    for (const file of REQUIRED_PYODIDE_RUNTIME_FILES) {
      const packagedFile = resolve(resourcesDir, "pyodide", file);
      if (!existsSync(packagedFile)) {
        errors.push(`Pyodide 打包缺失:${packagedFile}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`桌面运行时资源校验失败:\n${errors.join("\n")}`);
  }
}

export default function afterPack(context) {
  const projectDir = context.packager.projectDir;
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  assertPackagedResources({ projectDir, resourcesDir });
}
