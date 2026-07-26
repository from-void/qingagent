import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LARK_DEVICE_CODE,
  LarkCliRunner,
  resolveLarkCliInvocation,
} from "../larkCliRunner.js";

describe("LarkCliRunner 固定 argv", () => {
  it("Windows 打包态以 Electron-as-Node 直接执行随包 run.js，不启动 .cmd", async () => {
    const execFile = vi.fn(async (_file: string, args: readonly string[]) =>
      args.at(-1) === "--version"
        ? { stdout: "lark-cli version 1.0.65", stderr: "" }
        : { stdout: '{"configured":false}', stderr: "" });
    const runner = new LarkCliRunner({
      execFile,
      platform: "win32",
      shimPath: "C:\\Users\\me\\bin\\lark-cli.cmd",
      bundledRunJsPath: "C:\\Program Files\\qingagent\\resources\\lark-cli\\node_modules\\@larksuite\\cli\\scripts\\run.js",
      nodePath: "C:\\Program Files\\qingagent\\qingagent.exe",
      nodeOptions: '--require "C:/Users/me/bin/hide-console.cjs"',
      electronAsNode: true,
      exists: () => true,
    });

    await expect(runner.run(["config", "show"])).resolves.toMatchObject({
      ok: true,
      source: "bundle",
    });
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      "C:\\Program Files\\qingagent\\qingagent.exe",
      [
        "C:\\Program Files\\qingagent\\resources\\lark-cli\\node_modules\\@larksuite\\cli\\scripts\\run.js",
        "--version",
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: "1",
          NODE_OPTIONS: '--require "C:/Users/me/bin/hide-console.cjs"',
        }),
      }),
    );
    expect(execFile).toHaveBeenLastCalledWith(
      "C:\\Program Files\\qingagent\\qingagent.exe",
      [
        "C:\\Program Files\\qingagent\\resources\\lark-cli\\node_modules\\@larksuite\\cli\\scripts\\run.js",
        "config",
        "show",
      ],
      expect.any(Object),
    );
  });

  it("Windows 随包入口缺失时不误判 bundle，Unix 行为仍走 shim", () => {
    const win = resolveLarkCliInvocation({
      platform: "win32",
      shimPath: "C:\\bin\\lark-cli.cmd",
      bundledRunJsPath: "C:\\missing\\run.js",
      nodePath: "C:\\app\\qingagent.exe",
      exists: (path) => path === "C:\\bin\\lark-cli.cmd",
    });
    expect(win).toMatchObject({
      file: "C:\\bin\\lark-cli.cmd",
      argsPrefix: [],
      source: "shim",
    });

    const unix = resolveLarkCliInvocation({
      platform: "linux",
      shimPath: "/opt/qingagent/bin/lark-cli",
      bundledRunJsPath: "/resources/lark-cli/run.js",
      nodePath: "/opt/qingagent/qingagent",
      exists: () => true,
    });
    expect(unix).toEqual({
      file: "/opt/qingagent/bin/lark-cli",
      argsPrefix: [],
      source: "shim",
    });
  });

  it.each([
    ["EINVAL", "LARK_CLI_SPAWN_FAILED"],
    ["ETIMEDOUT", "LARK_CLI_VERSION_TIMEOUT"],
  ])("版本探测错误 %s 映射为 %s", async (code, reasonCode) => {
    const runner = new LarkCliRunner({
      shimPath: "/missing",
      execFile: async () => {
        throw Object.assign(new Error("internal raw error"), { code });
      },
    });
    await expect(runner.run(["config", "show"])).resolves.toMatchObject({
      ok: false,
      reasonCode,
    });
  });

  it("允许授权编排固定形态并把 AbortSignal 交给子进程", async () => {
    const execFile = vi.fn(async (_file: string, args: readonly string[]) =>
      args[0] === "--version"
        ? { stdout: "lark-cli version 1.0.65", stderr: "" }
        : { stdout: JSON.stringify({ verification_url: "https://example.test", user_code: "ABCD", device_code: "secret-code", expires_in: 300 }), stderr: "" });
    const runner = new LarkCliRunner({ execFile, shimPath: "/definitely/missing/lark-cli" });
    const controller = new AbortController();
    const result = await runner.run(["auth", "login", "--domain", "docs,calendar", "--no-wait", "--json"], { signal: controller.signal });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout).not.toContain("secret-code");
      expect(JSON.stringify(result)).not.toContain("secret-code");
      expect(result[LARK_DEVICE_CODE]).toBe("secret-code");
    }
    expect(execFile).toHaveBeenLastCalledWith("lark-cli", ["auth", "login", "--domain", "docs,calendar", "--no-wait", "--json"], expect.objectContaining({ signal: controller.signal }));
  });

  it("拒绝未知域、空 device code 与参数注入", async () => {
    const runner = new LarkCliRunner({ execFile: vi.fn(), shimPath: "/missing" });
    await expect(runner.run(["auth", "login", "--domain", "all", "--no-wait", "--json"])).rejects.toThrow("固定白名单");
    await expect(runner.run(["auth", "login", "--device-code", "--evil"])).rejects.toThrow("固定白名单");
  });

  it("可执行 lark-cli stub 驱动真实 execFile 集成路径", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-cli-stub-"));
    const stub = join(dir, "lark-cli");
    writeFileSync(stub, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "lark-cli version 1.0.65"; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"identities":{"user":{"available":false,"status":"missing"}}}'; exit 0; fi
exit 17
`);
    chmodSync(stub, 0o755);
    try {
      const runner = new LarkCliRunner({ shimPath: stub });
      const result = await runner.run(["auth", "status", "--json"]);
      expect(result).toMatchObject({ ok: true, source: "shim", cliVersion: "1.0.65" });
      if (result.ok) expect(result.stdout).toContain('"status":"missing"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
