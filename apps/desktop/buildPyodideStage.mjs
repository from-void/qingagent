import { createRequire } from "node:module";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_PYODIDE_RUNTIME_FILES = [
  "pyodide.mjs",
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

export function isBundlePyodideEnabled(value = process.env.QINGAGENT_BUNDLE_PYODIDE) {
  return ["1", "true", "on", "yes"].includes((value ?? "").trim().toLowerCase());
}

export function resolvePyodidePackageDir(cwd = process.cwd()) {
  const coreRequire = createRequire(
    pathToFileURL(resolve(cwd, "../../packages/core/package.json")),
  );
  return dirname(coreRequire.resolve("pyodide/package.json"));
}

export function stagePyodideResources({
  cwd = process.cwd(),
  bundle = isBundlePyodideEnabled(),
  pyodideDir = bundle ? resolvePyodidePackageDir(cwd) : null,
} = {}) {
  const stageDir = resolve(cwd, "build/pyodide");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  if (bundle) {
    if (!pyodideDir) throw new Error("pyodideDir is required when bundling Pyodide");
    for (const file of REQUIRED_PYODIDE_RUNTIME_FILES) {
      cpSync(join(pyodideDir, file), join(stageDir, file));
    }
    // 恢复 pyodide.asm.js 的 CommonJS 包边界,避免落在 desktop ESM 作用域下执行。
    writeFileSync(join(stageDir, "package.json"), "{\"type\":\"commonjs\"}\n");
    return { bundled: true, stageDir, files: [...REQUIRED_PYODIDE_RUNTIME_FILES] };
  }

  writeFileSync(
    join(stageDir, "DISABLED.txt"),
    "Pyodide not bundled. Rebuild with QINGAGENT_BUNDLE_PYODIDE=1 to include the Python runtime.\n",
  );
  return { bundled: false, stageDir, files: ["DISABLED.txt"] };
}
