// 宿主 Node 复用回归。
//
// 病根(0729 真机):桌面端启动时往**常驻 PATH 最前**的产品 CLI 目录写一个通用名 `node`
// (内容是 `ELECTRON_RUN_AS_NODE=1 exec <主程序>`),于是用户自己装的、shebang 写着
// `#!/usr/bin/env node` 的 CLI 全被主程序拉起,而不是用户终端里的那个 Node。系统凭据存储
// 按**调用程序身份**判权,身份一换就读不到用户终端里原有的登录态——同一台机器、同一个
// HOME、同一个凭据文件,终端里 0.7 秒返回用户名,产品里却只能转去重新授权。
//
// 这套用例锁住四条产品承诺:
// - 无隔离/全局免询问档下,产品运行时**绝不排在宿主 Node 前面**,宿主 CLI 照旧用宿主 Node;
// - 老版本残留在 PATH 目录里的 `node` shim 会被**主动删掉**,不能靠"这次不生成"糊弄;
// - 产品自带 CLI 需要产品运行时时**按绝对路径显式指定**,不受 PATH 站位影响;
// - 只读登录态查询绝不允许被自动升级成 `--force` 重新认证。
//
// 其中"PATH 站位真的决定了谁被拉起"这一条用**真实子进程**验证:临时目录里造一个
// `#!/usr/bin/env node` 的假 CLI + 两个身份不同的假 node,直接跑,看谁答应。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const ENV_KEYS = [
  "QINGAGENT_DATA_DIR",
  "QINGAGENT_SANDBOX_ISOLATION",
  "QINGAGENT_ALLOW_UNISOLATED_COMMANDS",
  "QINGAGENT_SANDBOX_NODE_RUNTIME",
  "PATH",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/** 建一份临时"宿主 + 产品"文件布局,并返回 fresh 模块图(数据目录随之改变)。 */
async function setupRuntimeFixture(options: {
  isolation: "none" | "bwrap";
  allowUnisolatedCommands?: boolean;
  nodeRuntimeSetting?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), "qingagent-host-node-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const hostBinDir = join(root, "host-bin");
  const hostCliDir = join(root, "host-cli");
  mkdirSync(hostBinDir, { recursive: true });
  mkdirSync(hostCliDir, { recursive: true });

  process.env.QINGAGENT_DATA_DIR = dataDir;
  process.env.QINGAGENT_SANDBOX_ISOLATION = options.isolation;
  if (options.allowUnisolatedCommands) process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS = "1";
  else delete process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS;
  if (options.nodeRuntimeSetting) process.env.QINGAGENT_SANDBOX_NODE_RUNTIME = options.nodeRuntimeSetting;
  else delete process.env.QINGAGENT_SANDBOX_NODE_RUNTIME;
  // 宿主 PATH 只留我们造的这一层:干净可断言。
  process.env.PATH = [hostBinDir, hostCliDir].join(delimiter);
  vi.resetModules();

  const paths = await import("../workspace/sandboxPaths.js");
  const shims = await import("../workspace/nodeRuntimeShim.js");
  const workspace = await import("../workspace/sessionWorkspace.js");

  // 宿主 Node(占位:用户终端里的那个,身份为 host)。
  writeExecutable(join(hostBinDir, "node"), "#!/bin/sh\necho HOST-NODE\n");
  // 用户自己装的 CLI:shebang 走 `env node`,谁在 PATH 前面就被谁拉起。
  writeExecutable(join(hostCliDir, "faux-cli"), "#!/usr/bin/env node\n");
  // 产品自带运行时(桌面上是主程序扮演 node)。
  const productShimPath = shims.ensureNodeRuntimeShim({
    execPath: "/opt/qingagent/qingagent",
    electron: true,
    platform: "linux",
  });
  writeExecutable(productShimPath, "#!/bin/sh\necho PRODUCT-RUNTIME\n");

  return { root, dataDir, hostBinDir, hostCliDir, paths, shims, workspace, productShimPath };
}

/** 用给定 PATH 真跑一次假 CLI,回答"它被谁拉起了"。 */
function runFauxCli(path: string): string {
  const result = spawnSync("faux-cli", [], {
    env: { PATH: path },
    encoding: "utf8",
  });
  return `${result.stdout ?? ""}`.trim();
}

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.resetModules();
});

describe.skipIf(process.platform === "win32")("宿主 Node 不被产品运行时劫持(真实子进程)", () => {
  it("无隔离 + 已放开未隔离命令:宿主 CLI 走宿主 Node,产品运行时只在末尾兜底", async () => {
    const fixture = await setupRuntimeFixture({
      isolation: "none",
      allowUnisolatedCommands: true,
    });

    expect(fixture.workspace.resolveNodeRuntimePathPlacement()).toBe("host-first");
    const env = fixture.workspace.buildSandboxEnv();
    const entries = env.PATH!.split(delimiter);
    // 产品 CLI 目录仍在最前(lark-cli 等靠它),但 Node 运行时被挤到宿主之后。
    expect(entries[0]).toBe(fixture.paths.SANDBOX_BIN_DIR);
    expect(entries.at(-1)).toBe(fixture.paths.SANDBOX_NODE_RUNTIME_DIR);
    expect(entries.indexOf(fixture.hostBinDir)).toBeLessThan(
      entries.indexOf(fixture.paths.SANDBOX_NODE_RUNTIME_DIR),
    );

    // 真机等价复现:同一条 `#!/usr/bin/env node` 的 CLI,在这份 PATH 下由宿主 Node 拉起。
    expect(runFauxCli(env.PATH!)).toBe("HOST-NODE");
  });

  it("宿主完全没有 Node 时,产品运行时仍然兜底(不是把能力砍掉)", async () => {
    const fixture = await setupRuntimeFixture({
      isolation: "none",
      allowUnisolatedCommands: true,
    });
    // 拿掉宿主 Node:此时没有任何可被劫持的对象,兜底必须生效。
    await rm(join(fixture.hostBinDir, "node"), { force: true });

    const env = fixture.workspace.buildSandboxEnv();
    expect(runFauxCli(env.PATH!)).toBe("PRODUCT-RUNTIME");
  });

  it("真文件隔离档维持产品运行时优先(宿主 Node 未必在沙箱里可用)", async () => {
    const fixture = await setupRuntimeFixture({ isolation: "bwrap" });

    expect(fixture.workspace.resolveNodeRuntimePathPlacement()).toBe("runtime-first");
    const env = fixture.workspace.buildSandboxEnv();
    const entries = env.PATH!.split(delimiter);
    expect(entries[1]).toBe(fixture.paths.SANDBOX_NODE_RUNTIME_DIR);
    expect(runFauxCli(env.PATH!)).toBe("PRODUCT-RUNTIME");
  });

  it("遗留在 PATH 目录里的 node shim 被删除,不再继续覆盖宿主 Node", async () => {
    const fixture = await setupRuntimeFixture({
      isolation: "none",
      allowUnisolatedCommands: true,
      // 关键:即使配置成"只用宿主 Node",老文件不删掉照样会劫持。
      nodeRuntimeSetting: "system",
    });
    // 复刻老版本布局:通用名 node 直接躺在常驻 PATH 最前的产品 CLI 目录里。
    const legacyShim = join(fixture.paths.SANDBOX_BIN_DIR, "node");
    writeExecutable(legacyShim, "#!/bin/sh\necho LEGACY-PRODUCT-RUNTIME\n");
    writeExecutable(join(fixture.paths.SANDBOX_BIN_DIR, "hide-console.cjs"), "//\n");
    const beforePrune = fixture.workspace.buildSandboxEnv();
    // 病症确认:不删就是会被劫持。
    expect(runFauxCli(beforePrune.PATH!)).toBe("LEGACY-PRODUCT-RUNTIME");

    const removed = fixture.shims.pruneLegacyNodeRuntimeShims();

    expect(removed).toContain("node");
    expect(removed).toContain("hide-console.cjs");
    expect(existsSync(legacyShim)).toBe(false);
    const afterPrune = fixture.workspace.buildSandboxEnv();
    expect(runFauxCli(afterPrune.PATH!)).toBe("HOST-NODE");
  });
});

describe("产品自带 CLI 的固定运行时", () => {
  it("产品运行时写进独立子目录,不占用产品 CLI 目录里的通用名 node", async () => {
    const fixture = await setupRuntimeFixture({ isolation: "bwrap" });

    expect(fixture.paths.SANDBOX_NODE_RUNTIME_DIR).toBe(
      join(fixture.paths.SANDBOX_BIN_DIR, "node-runtime"),
    );
    expect(fixture.productShimPath).toBe(join(fixture.paths.SANDBOX_NODE_RUNTIME_DIR, "node"));
    expect(existsSync(join(fixture.paths.SANDBOX_BIN_DIR, "node"))).toBe(false);
  });

  it("lark-cli 这类产品 CLI 按绝对路径锁定运行时,不受 PATH 站位影响", async () => {
    const fixture = await setupRuntimeFixture({
      isolation: "none",
      allowUnisolatedCommands: true,
    });
    const larkShim = await import("../workspace/larkCliShim.js");

    const rendered = larkShim.renderLarkCliShim({
      runJsPath: "/opt/qingagent/resources/lark-cli/run.js",
      nodePath: fixture.productShimPath,
      platform: "linux",
    });

    // 绝对路径引用产品运行时:宿主 Node 排在前面也改变不了它。
    expect(rendered.content).toContain(fixture.productShimPath);
    expect(rendered.content).not.toMatch(/^exec 'node'/m);
  });

  it("受信技能脚本这类「必须用产品运行时」的调用按次把运行时提到最前", async () => {
    const hostFirst = await setupRuntimeFixture({
      isolation: "none",
      allowUnisolatedCommands: true,
    });

    const perCall = hostFirst.workspace.productNodeRuntimePathEnv();
    expect(perCall.PATH!.split(delimiter)[0]).toBe(hostFirst.paths.SANDBOX_NODE_RUNTIME_DIR);
    // 只影响这一次调用:沙箱基础 env 仍然是宿主优先。
    expect(hostFirst.workspace.buildSandboxEnv().PATH!.split(delimiter)[0])
      .toBe(hostFirst.paths.SANDBOX_BIN_DIR);
    // 真跑一次:同一个假 CLI 在这份 env 下由产品运行时拉起。
    expect(runFauxCli(perCall.PATH!)).toBe("PRODUCT-RUNTIME");

    const runtimeFirst = await setupRuntimeFixture({ isolation: "bwrap" });
    // 产品运行时本来就在最前时不做任何无谓改写。
    expect(runtimeFirst.workspace.productNodeRuntimePathEnv()).toEqual({});
  });

  it("宿主优先档下不再对模型宣称产品运行时就绪", async () => {
    const hostFirst = await setupRuntimeFixture({
      isolation: "none",
      allowUnisolatedCommands: true,
    });
    const hostCaps = await import("../workspace/runtimeCapabilities.js");
    expect(hostCaps.detectSandboxRuntimeCapabilities().node).toBe("host");

    const runtimeFirst = await setupRuntimeFixture({ isolation: "bwrap" });
    expect(runtimeFirst.workspace.resolveNodeRuntimePathPlacement()).toBe("runtime-first");
    const runtimeCaps = await import("../workspace/runtimeCapabilities.js");
    expect(runtimeCaps.detectSandboxRuntimeCapabilities().node).toBe("shim-ready");
  });
});

describe("只读登录态查询不得被自动升级成强制重新认证", () => {
  let evaluateCommandPolicy: typeof import("../workspace/commandPolicy.js")["evaluateCommandPolicy"];

  beforeEach(async () => {
    vi.resetModules();
    ({ evaluateCommandPolicy } = await import("../workspace/commandPolicy.js"));
  });

  it("whoami 这类只读探测带上 --force 一律拒绝", () => {
    for (const command of [
      "faux-cli --force whoami --json",
      "faux-cli whoami --force",
      "faux-cli whoami --relogin",
      "echo hi && faux-cli --force whoami",
    ]) {
      const decision = evaluateCommandPolicy(command);
      expect(decision.action, command).toBe("deny");
      expect("reason" in decision ? decision.reason : "").toContain("只读的登录态查询");
    }
  });

  it("普通只读探测照旧放行,不受这条规则影响", () => {
    expect(evaluateCommandPolicy("faux-cli whoami --json").action).toBe("allow");
    expect(evaluateCommandPolicy("faux-cli auth status").action).toBe("allow");
  });

  it("常见的 -f 用法不被误伤", () => {
    expect(evaluateCommandPolicy("tail -f whoami.log").action).not.toBe("deny");
  });
});
