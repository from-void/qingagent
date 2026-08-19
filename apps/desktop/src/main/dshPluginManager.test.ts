import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      resolveNpx: () => ({ command: "/usr/local/bin/npx", prefixArgs: [] }),
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
    () => buildDshInstallInvocation("../web", detectedProfiles, {
      command: "/usr/local/bin/npx",
      prefixArgs: [],
    }),
    /profile/i,
  );
  assert.throws(
    () => buildDshInstallInvocation("missing", detectedProfiles, {
      command: "/usr/local/bin/npx",
      prefixArgs: [],
    }),
    /profile/i,
  );
});

test("安装命令使用解析后的调用、把前缀拼到精确参数数组并显式关闭 shell", () => {
  const invocation = buildDshInstallInvocation("web", ["web", "writer"], {
    command: "/usr/local/bin/node",
    prefixArgs: ["/usr/local/lib/node_modules/npm/bin/npx-cli.js"],
  });
  assert.equal(invocation.command, "/usr/local/bin/node");
  assert.deepEqual(invocation.args, [
    "/usr/local/lib/node_modules/npm/bin/npx-cli.js",
    "@deepseek-ai/dsh",
    "plugin",
    "--profile",
    "web",
    "add",
    "dsh-qingagent@latest",
  ]);
  assert.equal(invocation.options.shell, false);
});

test("posix 通过 which npx 所在目录解析原生可执行，查询过程不启用 shell", () => {
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

  assert.deepEqual(resolved, { command: "/usr/local/bin/npx", prefixArgs: [] });
  assert.deepEqual(calls, [{ command: "which", args: ["npx"], shell: false }]);
});

test("posix 优先使用 node + npx-cli.js 调用", () => {
  const files = new Set([
    "/usr/local/bin/node",
    "/usr/local/bin/npx",
    "/usr/local/lib/node_modules/npm/bin/npx-cli.js",
  ]);
  const resolved = resolveNpxExecutable({
    platform: "darwin",
    homeDir: "/Users/qingjian",
    env: {},
    lookup: () => "/usr/local/bin/npx\n",
    isFile: (filePath) => files.has(filePath),
    readDirectory: () => [],
  });

  assert.deepEqual(resolved, {
    command: "/usr/local/bin/node",
    prefixArgs: ["/usr/local/lib/node_modules/npm/bin/npx-cli.js"],
  });
});

test("Windows 忽略 where.exe 返回的无扩展名 npx，优先解析 node.exe + npx-cli.js", () => {
  const calls: Array<{ command: string; args: readonly string[]; shell: boolean }> = [];
  const files = new Set([
    "D:\\nodejs\\npx",
    "D:\\nodejs\\node.exe",
    "D:\\nodejs\\npx.cmd",
    "D:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
  ]);
  const resolved = resolveNpxExecutable({
    platform: "win32",
    homeDir: "C:\\Users\\qingjian",
    env: { SystemRoot: "C:\\Windows" },
    lookup(command, args, options) {
      calls.push({ command, args, shell: options.shell });
      return args[0] === "npx" ? "D:\\nodejs\\npx\r\n" : "";
    },
    isFile: (filePath) => files.has(filePath),
    readDirectory: () => [],
  });

  assert.deepEqual(resolved, {
    command: "D:\\nodejs\\node.exe",
    prefixArgs: ["D:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js"],
  });
  assert.notEqual(resolved?.command, "D:\\nodejs\\npx");
  assert.deepEqual(calls, [
    { command: "C:\\Windows\\System32\\where.exe", args: ["npx"], shell: false },
  ]);
});

test("Windows 只有 npx.cmd 时通过 cmd.exe 以参数数组调用", () => {
  const resolved = resolveNpxExecutable({
    platform: "win32",
    homeDir: "C:\\Users\\qingjian",
    env: { SystemRoot: "C:\\Windows" },
    lookup: (_command, args) => args[0] === "npx" ? "D:\\nodejs\\npx.cmd\r\n" : "",
    isFile: (filePath) => filePath === "D:\\nodejs\\npx.cmd",
    readDirectory: () => [],
  });

  assert.deepEqual(resolved, {
    command: "C:\\Windows\\System32\\cmd.exe",
    prefixArgs: ["/d", "/s", "/c", "D:\\nodejs\\npx.cmd"],
  });
});

test("Windows 只有 npx.exe 时直接使用原生可执行", () => {
  const resolved = resolveNpxExecutable({
    platform: "win32",
    homeDir: "C:\\Users\\qingjian",
    env: { SystemRoot: "C:\\Windows" },
    lookup: (_command, args) => args[0] === "npx" ? "D:\\nodejs\\npx.exe\r\n" : "",
    isFile: (filePath) => filePath === "D:\\nodejs\\npx.exe",
    readDirectory: () => [],
  });

  assert.deepEqual(resolved, { command: "D:\\nodejs\\npx.exe", prefixArgs: [] });
});

test("Windows 只有无扩展名 npx 时不把它当作可执行调用", () => {
  const resolved = resolveNpxExecutable({
    platform: "win32",
    homeDir: "C:\\Users\\qingjian",
    env: { SystemRoot: "C:\\Windows" },
    lookup: (_command, args) => args[0] === "npx" ? "D:\\nodejs\\npx\r\n" : "",
    isFile: (filePath) => filePath === "D:\\nodejs\\npx",
    readDirectory: () => [],
  });

  assert.equal(resolved, null);
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
      return filePath === "D:\\nodejs\\npx.exe";
    },
    readDirectory: () => [],
  });

  assert.deepEqual(resolved, { command: "D:\\nodejs\\npx.exe", prefixArgs: [] });
  assert.ok(probedPaths.includes("C:\\Windows\\System32\\npx.exe"));
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

  assert.deepEqual(resolved, {
    command: "C:\\Windows\\System32\\cmd.exe",
    prefixArgs: [
      "/d",
      "/s",
      "/c",
      "C:\\Users\\qingjian\\AppData\\Roaming\\npm\\npx.cmd",
    ],
  });
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
  assert.deepEqual(posix, {
    command: "/Users/qingjian/.nvm/versions/node/v20.19.0/bin/npx",
    prefixArgs: [],
  });

  const windows = resolveNpxExecutable({
    platform: "win32",
    homeDir: "C:\\Users\\qingjian",
    env: {
      APPDATA: "C:\\Users\\qingjian\\AppData\\Roaming",
      SystemRoot: "C:\\Windows",
    },
    lookup: () => {
      throw new Error("where failed");
    },
    isFile: (filePath) => filePath.endsWith("AppData\\Roaming\\npm\\npx.cmd"),
    readDirectory: () => [],
  });
  assert.deepEqual(windows, {
    command: "C:\\Windows\\System32\\cmd.exe",
    prefixArgs: [
      "/d",
      "/s",
      "/c",
      "C:\\Users\\qingjian\\AppData\\Roaming\\npm\\npx.cmd",
    ],
  });

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

test("DSH 插件安装实现禁止 shell:true", () => {
  const source = readFileSync(new URL("./dshPluginManager.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /shell\s*:\s*true/u);
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
