import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertPackagedResources } from "./afterPackResources.mjs";
import { REQUIRED_PYODIDE_RUNTIME_FILES } from "./buildPyodideStage.mjs";
import { LARK_CLI_RUN_JS_RELATIVE } from "./stageLarkCli.mjs";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "desktop-after-pack-"));
  const fixture = {
    root,
    projectDir: join(root, "project"),
    resourcesDir: join(root, "app", "resources"),
  };
  writeFixtureFile(
    join(fixture.projectDir, "dist/main/index.js"),
    [
      'process.env.QINGAGENT_BROWSER_STORAGE_STATE = path.join(userDataDir, ".qingagent-browser-state.json");',
      'process.env.QINGAGENT_BROWSER_PROFILE_DIR = path.join(userDataDir, ".qingagent-browser-profile");',
    ].join("\n"),
  );
  return fixture;
}

function writeFixtureFile(path, content = "fixture\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function stageLarkCli(projectDir) {
  writeFixtureFile(join(projectDir, "build/lark-cli", LARK_CLI_RUN_JS_RELATIVE));
}

function packageLarkCli(resourcesDir) {
  writeFixtureFile(join(resourcesDir, "lark-cli", LARK_CLI_RUN_JS_RELATIVE));
}

function stagePyodide(projectDir) {
  for (const file of REQUIRED_PYODIDE_RUNTIME_FILES) {
    writeFixtureFile(join(projectDir, "build/pyodide", file));
  }
}

function packagePyodide(resourcesDir, files = REQUIRED_PYODIDE_RUNTIME_FILES) {
  for (const file of files) {
    writeFixtureFile(join(resourcesDir, "pyodide", file));
  }
}

test("完整暂存的 lark-cli 未进入包时构建失败", () => {
  const fixture = makeFixture();
  try {
    stageLarkCli(fixture.projectDir);

    assert.throws(
      () => assertPackagedResources(fixture),
      /桌面运行时资源校验失败:[\s\S]*飞书 lark-cli 打包缺失:/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("完整暂存的 Pyodide 有文件未进入包时构建失败", () => {
  const fixture = makeFixture();
  try {
    stagePyodide(fixture.projectDir);
    packagePyodide(
      fixture.resourcesDir,
      REQUIRED_PYODIDE_RUNTIME_FILES.filter((file) => file !== "python_stdlib.zip"),
    );

    assert.throws(
      () => assertPackagedResources(fixture),
      /桌面运行时资源校验失败:[\s\S]*Pyodide 打包缺失:.*python_stdlib\.zip/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("瘦包暂存不触发资源断言", () => {
  const fixture = makeFixture();
  try {
    writeFixtureFile(join(fixture.projectDir, "build/lark-cli/DISABLED.txt"));
    writeFixtureFile(join(fixture.projectDir, "build/pyodide/DISABLED.txt"));

    assert.doesNotThrow(() => assertPackagedResources(fixture));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("完整暂存资源全部进入包时通过", () => {
  const fixture = makeFixture();
  try {
    stageLarkCli(fixture.projectDir);
    packageLarkCli(fixture.resourcesDir);
    stagePyodide(fixture.projectDir);
    packagePyodide(fixture.resourcesDir);

    assert.doesNotThrow(() => assertPackagedResources(fixture));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("最终 bundle 中任一 agent browser 敏感路径回退 cwd 时构建失败", () => {
  for (const sensitiveName of [
    ".qingagent-browser-state.json",
    ".qingagent-browser-profile",
  ]) {
    const fixture = makeFixture();
    try {
      writeFixtureFile(
        join(fixture.projectDir, "dist/main/index.js"),
        [
          'process.env.QINGAGENT_BROWSER_STORAGE_STATE = path.join(userDataDir, ".qingagent-browser-state.json");',
          'process.env.QINGAGENT_BROWSER_PROFILE_DIR = path.join(userDataDir, ".qingagent-browser-profile");',
          `const leakedPath = join(process.cwd(), "${sensitiveName}");`,
        ].join("\n"),
      );

      assert.throws(
        () => assertPackagedResources(fixture),
        new RegExp(`桌面运行时资源校验失败:[\\s\\S]*agent browser 敏感路径仍依赖 cwd:${sensitiveName.replace(".", "\\.")}`),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});
