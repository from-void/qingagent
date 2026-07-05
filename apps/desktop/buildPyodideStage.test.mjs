import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REQUIRED_PYODIDE_RUNTIME_FILES,
  isBundlePyodideEnabled,
  stagePyodideResources,
} from "./buildPyodideStage.mjs";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePyodideDir(root) {
  const pyodideDir = join(root, "pyodide-package");
  mkdirSync(pyodideDir, { recursive: true });
  for (const file of REQUIRED_PYODIDE_RUNTIME_FILES) {
    writeFileSync(join(pyodideDir, file), `${file}\n`);
  }
  return pyodideDir;
}

test("QINGAGENT_BUNDLE_PYODIDE=1 暂存运行时文件并写入 commonjs 包边界", () => {
  const cwd = makeTempDir("desktop-pyodide-on-");
  try {
    const pyodideDir = makeFakePyodideDir(cwd);

    const result = stagePyodideResources({ cwd, bundle: true, pyodideDir });

    assert.equal(result.bundled, true);
    for (const file of REQUIRED_PYODIDE_RUNTIME_FILES) {
      assert.equal(readFileSync(join(result.stageDir, file), "utf8"), `${file}\n`);
    }
    assert.deepEqual(
      JSON.parse(readFileSync(join(result.stageDir, "package.json"), "utf8")),
      { type: "commonjs" },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("QINGAGENT_BUNDLE_PYODIDE 关闭时只写占位文件", () => {
  const cwd = makeTempDir("desktop-pyodide-off-");
  try {
    const result = stagePyodideResources({ cwd, bundle: false });

    assert.equal(result.bundled, false);
    assert.deepEqual(readdirSync(result.stageDir), ["DISABLED.txt"]);
    assert.equal(existsSync(join(result.stageDir, "package.json")), false);
    for (const file of REQUIRED_PYODIDE_RUNTIME_FILES) {
      assert.equal(existsSync(join(result.stageDir, file)), false);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Pyodide 打包开关识别常用真值", () => {
  assert.equal(isBundlePyodideEnabled("1"), true);
  assert.equal(isBundlePyodideEnabled("yes"), true);
  assert.equal(isBundlePyodideEnabled("0"), false);
  assert.equal(isBundlePyodideEnabled(undefined), false);
});
