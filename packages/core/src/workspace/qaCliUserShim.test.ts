import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureQaCliUserShim, renderQaCliUserShim } from "./qaCliUserShim.js";

// qa CLI 用户终端 shim:跨平台渲染 + 落盘可执行 + /usr/local/bin symlink 三态(缺失建/自有重指/他有不动)。
describe("renderQaCliUserShim", () => {
  const opts = {
    execPath: "/Applications/青简.app/Contents/MacOS/qingagent",
    cliJsPath: "/Applications/青简.app/Contents/Resources/qa-cli/cli.mjs",
  };

  it("Unix:shell 脚本,ELECTRON_RUN_AS_NODE=1 exec 应用二进制跑 cli.mjs,0755", () => {
    const r = renderQaCliUserShim({ ...opts, platform: "darwin" });
    expect(r.filename).toBe("qa");
    expect(r.mode).toBe(0o755);
    expect(r.content).toContain("#!/bin/sh");
    expect(r.content).toContain(
      "ELECTRON_RUN_AS_NODE=1 exec '/Applications/青简.app/Contents/MacOS/qingagent' '/Applications/青简.app/Contents/Resources/qa-cli/cli.mjs' \"$@\"",
    );
  });

  it("Windows:.cmd,setlocal 设 ELECTRON_RUN_AS_NODE 后透传 %*", () => {
    const r = renderQaCliUserShim({
      execPath: "C:\\Program Files\\qingagent\\qingagent.exe",
      cliJsPath: "C:\\Program Files\\qingagent\\resources\\qa-cli\\cli.mjs",
      platform: "win32",
    });
    expect(r.filename).toBe("qa.cmd");
    expect(r.content).toContain("set ELECTRON_RUN_AS_NODE=1");
    expect(r.content).toContain(
      '"C:\\Program Files\\qingagent\\qingagent.exe" "C:\\Program Files\\qingagent\\resources\\qa-cli\\cli.mjs" %*',
    );
  });
});

describe("ensureQaCliUserShim", () => {
  const dirs: string[] = [];
  function tmp(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const opts = { execPath: "/opt/app/qingagent", cliJsPath: "/opt/app/resources/qa-cli/cli.mjs" };

  it("写入 binDir/qa 可执行文件并建 symlink;symlink 目录在 PATH 上则 onPath=true", () => {
    const binDir = tmp("qa-bin-");
    const linkDir = tmp("qa-link-");
    const r = ensureQaCliUserShim({
      ...opts,
      platform: "linux",
      binDir,
      symlinkDir: linkDir,
      pathEnv: `/usr/bin:${linkDir}`,
    });
    expect(r.shimPath).toBe(join(binDir, "qa"));
    expect(readFileSync(r.shimPath, "utf8")).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(statSync(r.shimPath).mode & 0o755).toBe(0o755);
    expect(r.symlinkPath).toBe(join(linkDir, "qa"));
    expect(readlinkSync(r.symlinkPath!)).toBe(r.shimPath);
    expect(r.onPath).toBe(true);
  });

  it("symlink 位置已被用户自己的文件占据:不覆盖,onPath 按 binDir 判", () => {
    const binDir = tmp("qa-bin-");
    const linkDir = tmp("qa-link-");
    writeFileSync(join(linkDir, "qa"), "#!/bin/sh\necho user-own\n");
    const r = ensureQaCliUserShim({
      ...opts,
      platform: "linux",
      binDir,
      symlinkDir: linkDir,
      pathEnv: "/usr/bin",
    });
    expect(r.symlinkPath).toBeUndefined();
    expect(readFileSync(join(linkDir, "qa"), "utf8")).toContain("user-own");
    expect(r.onPath).toBe(false);
  });

  it("symlink 指向旧 .qingagent/bin 位置:视为自有,原子重指到新 shim", () => {
    const binDir = tmp("qa-bin-");
    const linkDir = tmp("qa-link-");
    const legacyTarget = join(tmp("legacy-"), ".qingagent", "bin", "qa");
    symlinkSync(legacyTarget, join(linkDir, "qa"));
    const r = ensureQaCliUserShim({
      ...opts,
      platform: "linux",
      binDir,
      symlinkDir: linkDir,
      pathEnv: "",
    });
    expect(r.symlinkPath).toBe(join(linkDir, "qa"));
    expect(readlinkSync(join(linkDir, "qa"))).toBe(join(binDir, "qa"));
  });

  it("symlinkDir=null 显式关闭;binDir 在 PATH 上时 onPath=true", () => {
    const binDir = tmp("qa-bin-");
    const r = ensureQaCliUserShim({
      ...opts,
      platform: "linux",
      binDir,
      symlinkDir: null,
      pathEnv: `${binDir}:/usr/bin`,
    });
    expect(r.symlinkPath).toBeUndefined();
    expect(r.onPath).toBe(true);
  });

  it("win32:写 qa.cmd,不做 symlink", () => {
    const binDir = tmp("qa-bin-");
    const r = ensureQaCliUserShim({
      execPath: "C:\\app\\qingagent.exe",
      cliJsPath: "C:\\app\\resources\\qa-cli\\cli.mjs",
      platform: "win32",
      binDir,
      pathEnv: binDir,
    });
    expect(r.shimPath).toBe(join(binDir, "qa.cmd"));
    expect(r.symlinkPath).toBeUndefined();
    expect(r.onPath).toBe(true);
  });
});
