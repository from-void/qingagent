import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ensureNodeRuntimeShim,
  isElectronRuntime,
  posixSingleQuote,
  renderNodeRuntimeShim,
  renderWindowsNodeOptions,
  writeIfChanged,
} from "../workspace/nodeRuntimeShim.js";

describe("nodeRuntimeShim", () => {
  it("Round6 回归:Electron 运行时不依赖 app.isPackaged 判定", () => {
    const nodeVersions = { ...process.versions };
    delete (nodeVersions as { electron?: string }).electron;
    expect(isElectronRuntime({ ...process.versions, electron: "33.4.0" })).toBe(true);
    expect(isElectronRuntime(nodeVersions)).toBe(false);
  });

  it("POSIX 单引号能处理空格、单引号与 $", () => {
    expect(posixSingleQuote("/tmp/a b/it'$node")).toBe("'/tmp/a b/it'\\''$node'");
    const rendered = renderNodeRuntimeShim({
      execPath: "/tmp/app dir/Qingagent'$App",
      electron: true,
      platform: "linux",
    });
    expect(rendered.filename).toBe("node");
    expect(rendered.mode).toBe(0o755);
    expect(rendered.content).toContain("export ELECTRON_RUN_AS_NODE=1");
    expect(rendered.content).toContain("unset NODE_OPTIONS");
    expect(rendered.content).toContain("exec '/tmp/app dir/Qingagent'\\''$App' \"$@\"");
  });

  it("Windows .cmd 第一行是 @echo off,并转义 %", () => {
    const rendered = renderNodeRuntimeShim({
      execPath: "C:\\Program Files\\青简 100%\\青简.exe",
      electron: true,
      binDir: "C:\\Users\\Test User\\AppData\\Roaming\\青简\\data\\bin",
      platform: "win32",
    });
    const lines = rendered.content.split(/\r?\n/);
    expect(rendered.filename).toBe("node.cmd");
    expect(lines[0]).toBe("@echo off");
    expect(rendered.content).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(rendered.content).toContain(
      'set NODE_OPTIONS=--require "C:/Users/Test User/AppData/Roaming/青简/data/bin/hide-console.cjs"',
    );
    expect(lines.find((line) => line.startsWith("set NODE_OPTIONS="))).not.toContain("%~dp0");
    expect(lines.find((line) => line.startsWith("set NODE_OPTIONS="))).not.toContain("\\");
    expect(rendered.content).toContain('"C:\\Program Files\\青简 100%%\\青简.exe" %*');
  });

  it("Windows NODE_OPTIONS 使用绝对正斜杠路径并正确引用空格", () => {
    expect(
      renderWindowsNodeOptions("C:\\Users\\Test User\\AppData\\Roaming\\青简\\data\\bin"),
    ).toBe('--require "C:/Users/Test User/AppData/Roaming/青简/data/bin/hide-console.cjs"');
  });

  it("Node 从 NODE_OPTIONS 解析反斜杠 preload 路径时会吞掉反斜杠", () => {
    const preloadPath = "C:\\Users\\Test User\\sessions\\fixture\\hide-console.cjs";
    const result = spawnSync(process.execPath, ["-e", "0"], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require "${preloadPath}"`,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Cannot find module '${preloadPath.replace(/\\/g, "")}'`,
    );
    expect(result.stderr).not.toContain(preloadPath);
  });

  it("win32+electron 时写出 hide-console.cjs,并可由 NODE_OPTIONS 环境变量预载", async () => {
    const dir = mkdtempSync(join(tmpdir(), "node-shim hide-"));
    ensureNodeRuntimeShim({
      execPath: "C:\\app\\qingagent.exe",
      electron: true,
      binDir: dir,
      platform: "win32",
    });
    const preload = await readFile(join(dir, "hide-console.cjs"), "utf8");
    expect(preload).toContain("windowsHide");
    expect(preload).toContain("execFileSync");
    // 必须走 NODE_OPTIONS 环境变量,覆盖 Node 自身的 env 解析器；CLI --require 不能复现本缺陷。
    const result = spawnSync(process.execPath, ["-e", "0"], {
      env: {
        ...process.env,
        NODE_OPTIONS: renderWindowsNodeOptions(dir),
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("非 electron 的 win32 shim 不注入 NODE_OPTIONS 预载", () => {
    const rendered = renderNodeRuntimeShim({
      execPath: "D:\\nodejs\\node.exe",
      electron: false,
      platform: "win32",
    });
    expect(rendered.content).not.toContain("NODE_OPTIONS");
    expect(rendered.content).not.toContain("hide-console");
  });

  it("writeIfChanged 幂等,内容变化才重写", async () => {
    const dir = mkdtempSync(join(tmpdir(), "node-shim-"));
    const file = join(dir, "node");
    expect(writeIfChanged(file, "a")).toBe(true);
    const first = statSync(file).mtimeMs;
    expect(writeIfChanged(file, "a")).toBe(false);
    expect(statSync(file).mtimeMs).toBe(first);
    expect(writeIfChanged(file, "b")).toBe(true);
    expect(await readFile(file, "utf8")).toBe("b");
  });

  it("ensureNodeRuntimeShim 创建目录并写入对应平台 shim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "node-shim-bin-"));
    const nested = join(dir, "nested", "bin");
    mkdirSync(dir, { recursive: true });
    const shimPath = ensureNodeRuntimeShim({
      execPath: "/Applications/Qingagent App/Qingagent",
      electron: false,
      binDir: nested,
      platform: "darwin",
    });
    expect(shimPath).toBe(join(nested, "node"));
    expect(await readFile(shimPath, "utf8")).toContain("exec '/Applications/Qingagent App/Qingagent' \"$@\"");
  });
});
