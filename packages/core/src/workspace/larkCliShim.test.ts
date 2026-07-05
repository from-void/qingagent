import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLarkCliShim, renderLarkCliShim } from "./larkCliShim.js";

// lark-cli 沙箱 shim:跨平台渲染(Unix shell / Windows .cmd)+ 落盘可执行 + 含 node/run.js 路径。
describe("renderLarkCliShim", () => {
  const opts = {
    runJsPath: "/res/lark-cli/scripts/run.js",
    nodePath: "/bin/node",
  };

  it("Unix:shell 脚本,exec node run.js \"$@\",0755", () => {
    const r = renderLarkCliShim({ ...opts, platform: "linux" });
    expect(r.filename).toBe("lark-cli");
    expect(r.mode).toBe(0o755);
    expect(r.content).toContain("#!/bin/sh");
    expect(r.content).toContain("exec '/bin/node' '/res/lark-cli/scripts/run.js' \"$@\"");
  });

  it("Windows:.cmd,call node.cmd run.js %*", () => {
    const r = renderLarkCliShim({
      runJsPath: "C:\\res\\lark-cli\\scripts\\run.js",
      nodePath: "C:\\bin\\node.cmd",
      platform: "win32",
    });
    expect(r.filename).toBe("lark-cli.cmd");
    expect(r.content).toContain("@echo off");
    expect(r.content).toContain('call "C:\\bin\\node.cmd" "C:\\res\\lark-cli\\scripts\\run.js" %*');
    expect(r.content.endsWith("\r\n")).toBe(true);
  });

  it("Unix:含单引号的路径被安全转义", () => {
    const r = renderLarkCliShim({
      runJsPath: "/o'dd/run.js",
      nodePath: "/bin/node",
      platform: "linux",
    });
    expect(r.content).toContain("'/o'\\''dd/run.js'");
  });
});

describe("ensureLarkCliShim", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("写入 binDir 并设可执行位(Unix)", () => {
    dir = mkdtempSync(join(tmpdir(), "lark-shim-"));
    const p = ensureLarkCliShim({
      runJsPath: "/res/lark-cli/scripts/run.js",
      nodePath: "/bin/node",
      binDir: dir,
      platform: "linux",
    });
    expect(p).toBe(join(dir, "lark-cli"));
    expect(readFileSync(p, "utf8")).toContain("/res/lark-cli/scripts/run.js");
    // 0o755 可执行
    expect(statSync(p).mode & 0o111).not.toBe(0);
  });
});
