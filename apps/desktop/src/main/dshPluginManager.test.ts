import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDshInstallInvocation,
  detectDshInstallation,
  installDshPlugin,
  resolveNpxExecutable,
} from "./dshPluginManager.js";

test("按 settings.yaml 与 profiles 目录枚举 DSH profile，并读取 bundle 与插件版本", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "qingagent-dsh-"));
  try {
    const dshDir = path.join(homeDir, ".dsh");
    mkdirSync(path.join(dshDir, "profiles", "writer"), { recursive: true });
    mkdirSync(
      path.join(dshDir, "profiles", "web", "node_modules", "dsh-qingagent"),
      { recursive: true },
    );
    writeFileSync(path.join(dshDir, "settings.yaml"), "version: 1\n");
    writeJson(path.join(dshDir, "profiles", "writer", "package.json"), {
      name: "writer",
      dsh: { profile: { bundles: ["dsh-writer"] } },
      dependencies: { "dsh-qingagent": "link:../../dev/dsh-qingagent" },
    });
    writeJson(path.join(dshDir, "profiles", "web", "package.json"), {
      name: "web",
      dsh: { profile: { bundles: ["dsh-web-app", "dsh-browser"] } },
    });
    writeJson(
      path.join(dshDir, "profiles", "web", "node_modules", "dsh-qingagent", "package.json"),
      { name: "dsh-qingagent", version: "0.1.21" },
    );

    assert.deepEqual(detectDshInstallation(homeDir, {
      resolveNpx: () => "/usr/local/bin/npx",
    }), {
      detected: true,
      profiles: [
        { name: "web", bundles: ["dsh-web-app", "dsh-browser"], pluginVersion: "0.1.21" },
        { name: "writer", bundles: ["dsh-writer"], pluginVersion: null },
      ],
      defaultProfile: "web",
      npxAvailable: true,
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("缺少 settings.yaml 时不把残留 profiles 误判为已安装 DSH", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "qingagent-dsh-"));
  try {
    mkdirSync(path.join(homeDir, ".dsh", "profiles", "web"), { recursive: true });
    writeJson(path.join(homeDir, ".dsh", "profiles", "web", "package.json"), {
      dsh: { profile: { bundles: ["dsh-web-app"] } },
    });
    assert.deepEqual(detectDshInstallation(homeDir, {
      resolveNpx: () => null,
    }), {
      detected: false,
      profiles: [],
      defaultProfile: null,
      npxAvailable: false,
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("安装命令拒绝路径穿越与未枚举 profile", () => {
  const detectedProfiles = ["web", "writer"];
  assert.throws(
    () => buildDshInstallInvocation("../web", detectedProfiles, "/usr/local/bin/npx"),
    /profile/i,
  );
  assert.throws(
    () => buildDshInstallInvocation("missing", detectedProfiles, "/usr/local/bin/npx"),
    /profile/i,
  );
});

test("安装命令使用解析后的绝对路径、精确参数数组并显式关闭 shell", () => {
  const invocation = buildDshInstallInvocation("web", ["web", "writer"], "/usr/local/bin/npx");
  assert.equal(invocation.command, "/usr/local/bin/npx");
  assert.deepEqual(invocation.args, [
    "@deepseek-ai/dsh",
    "plugin",
    "--profile",
    "web",
    "add",
    "dsh-qingagent@latest",
  ]);
  assert.equal(invocation.options.shell, false);
});

test("posix 通过 which npx 解析真实路径，查询过程不启用 shell", () => {
  const calls: Array<{ command: string; args: readonly string[]; shell: boolean }> = [];
  const resolved = resolveNpxExecutable({
    platform: "linux",
    homeDir: "/home/qingjian",
    env: {},
    lookup(command, args, options) {
      calls.push({ command, args, shell: options.shell });
      return "/usr/local/bin/npx\n";
    },
    isFile: (filePath) => filePath === "/usr/local/bin/npx",
    readDirectory: () => [],
  });

  assert.equal(resolved, "/usr/local/bin/npx");
  assert.deepEqual(calls, [{ command: "which", args: ["npx"], shell: false }]);
});

test("Windows 依次用 where.exe 查 npx 与 npx.cmd，并返回带扩展名绝对路径", () => {
  const calls: Array<{ command: string; args: readonly string[]; shell: boolean }> = [];
  const resolved = resolveNpxExecutable({
    platform: "win32",
    homeDir: "C:\\Users\\qingjian",
    env: { SystemRoot: "C:\\Windows" },
    lookup(command, args, options) {
      calls.push({ command, args, shell: options.shell });
      return args[0] === "npx.cmd" ? "C:\\Program Files\\nodejs\\npx.cmd\r\n" : "";
    },
    isFile: (filePath) => filePath === "C:\\Program Files\\nodejs\\npx.cmd",
    readDirectory: () => [],
  });

  assert.equal(resolved, "C:\\Program Files\\nodejs\\npx.cmd");
  assert.deepEqual(calls, [
    { command: "C:\\Windows\\System32\\where.exe", args: ["npx"], shell: false },
    { command: "C:\\Windows\\System32\\where.exe", args: ["npx.cmd"], shell: false },
  ]);
});

test("Windows 从系统注册表 PATH 解析自定义盘符 npx，并展开环境变量", () => {
  const calls: Array<{ command: string; args: readonly string[]; shell: boolean }> = [];
  const probedPaths: string[] = [];
  const resolved = resolveNpxExecutable({
    platform: "win32",
    homeDir: "C:\\Users\\qingjian",
    env: { SystemRoot: "C:\\Windows" },
    lookup(command, args, options) {
      calls.push({ command, args, shell: options.shell });
      if (command.endsWith("where.exe")) return "";
      if (args[1]?.startsWith("HKLM")) {
        return [
          "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
          "    Path    REG_EXPAND_SZ    %SystemRoot%\\System32;D:\\nodejs\\",
          "",
        ].join("\r\n");
      }
      return [
        "HKEY_CURRENT_USER\\Environment",
        "    Path    REG_SZ    C:\\Users\\qingjian\\bin",
        "",
      ].join("\r\n");
    },
    isFile(filePath) {
      probedPaths.push(filePath);
      return filePath === "D:\\nodejs\\npx.cmd";
    },
    readDirectory: () => [],
  });

  assert.equal(resolved, "D:\\nodejs\\npx.cmd");
  assert.ok(probedPaths.includes("C:\\Windows\\System32\\npx.cmd"));
  assert.ok(calls.some(({ args }) => args[1]?.startsWith("HKLM")));
  assert.ok(calls.some(({ args }) => args[1]?.startsWith("HKCU")));
  assert.ok(calls.every(({ shell }) => shell === false));
});

test("Windows 注册表查询失败或空输出时回落常见位置，全程不启用 shell", () => {
  const calls: Array<{ command: string; args: readonly string[]; shell: boolean }> = [];
  const resolved = resolveNpxExecutable({
    platform: "win32",
    homeDir: "C:\\Users\\qingjian",
    env: {
      SystemRoot: "C:\\Windows",
      APPDATA: "C:\\Users\\qingjian\\AppData\\Roaming",
    },
    lookup(command, args, options) {
      calls.push({ command, args, shell: options.shell });
      if (command.endsWith("where.exe")) return "";
      if (args[1]?.startsWith("HKLM")) throw new Error("reg query failed");
      return "";
    },
    isFile: (filePath) => filePath === "C:\\Users\\qingjian\\AppData\\Roaming\\npm\\npx.cmd",
    readDirectory: () => [],
  });

  assert.equal(resolved, "C:\\Users\\qingjian\\AppData\\Roaming\\npm\\npx.cmd");
  assert.ok(calls.some(({ args }) => args[1]?.startsWith("HKLM")));
  assert.ok(calls.some(({ args }) => args[1]?.startsWith("HKCU")));
  assert.ok(calls.every(({ shell }) => shell === false));
});

test("查询失败时补查 nvm/volta/fnm 与 APPDATA 常见目录，仍找不到则返回 null", () => {
  const posix = resolveNpxExecutable({
    platform: "darwin",
    homeDir: "/Users/qingjian",
    env: { NVM_BIN: "/Users/qingjian/.nvm/versions/node/v20.19.0/bin" },
    lookup: () => {
      throw new Error("which failed");
    },
    isFile: (filePath) => filePath.endsWith("/v20.19.0/bin/npx"),
    readDirectory: () => [],
  });
  assert.equal(posix, "/Users/qingjian/.nvm/versions/node/v20.19.0/bin/npx");

  const windows = resolveNpxExecutable({
    platform: "win32",
    homeDir: "C:\\Users\\qingjian",
    env: { APPDATA: "C:\\Users\\qingjian\\AppData\\Roaming" },
    lookup: () => {
      throw new Error("where failed");
    },
    isFile: (filePath) => filePath.endsWith("AppData\\Roaming\\npm\\npx.cmd"),
    readDirectory: () => [],
  });
  assert.equal(windows, "C:\\Users\\qingjian\\AppData\\Roaming\\npm\\npx.cmd");

  const missing = resolveNpxExecutable({
    platform: "linux",
    homeDir: "/home/qingjian",
    env: {},
    lookup: () => "",
    isFile: () => false,
    readDirectory: () => [],
  });
  assert.equal(missing, null);
});

test("解析不到 npx 时不触发 spawn，也不把 ENOENT 当执行失败", async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "qingagent-dsh-"));
  try {
    createDshProfile(homeDir, "web");
    let spawnCalls = 0;
    const result = await installDshPlugin("web", {
      homeDir,
      resolveNpx: () => null,
      spawnProcess: (() => {
        spawnCalls += 1;
        throw new Error("spawn should not run");
      }) as never,
    });

    assert.equal(spawnCalls, 0);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "npx-not-found");
      assert.match(result.stderr, /未找到 Node\/npx/);
      assert.doesNotMatch(result.stderr, /ENOENT/);
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

function createDshProfile(homeDir: string, profile: string): void {
  const dshDir = path.join(homeDir, ".dsh");
  mkdirSync(path.join(dshDir, "profiles", profile), { recursive: true });
  writeFileSync(path.join(dshDir, "settings.yaml"), "version: 1\n");
  writeJson(path.join(dshDir, "profiles", profile, "package.json"), {
    name: profile,
    dsh: { profile: { bundles: ["dsh-web-app"] } },
  });
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}
