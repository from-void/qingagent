import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LARK_CLI_RUN_JS_RELATIVE,
  isBundleLarkCliEnabled,
  stageLarkCli,
} from "./stageLarkCli.mjs";

// 不联网:只测 flag 解析与「关闭」分支(占位文件);开启分支走 npm install,由 build.mjs 实跑验证。
test("isBundleLarkCliEnabled:默认/空 → ON", () => {
  assert.equal(isBundleLarkCliEnabled(undefined), true);
  assert.equal(isBundleLarkCliEnabled(""), true);
  assert.equal(isBundleLarkCliEnabled("  "), true);
  assert.equal(isBundleLarkCliEnabled("1"), true);
  assert.equal(isBundleLarkCliEnabled("true"), true);
});

test("isBundleLarkCliEnabled:显式假值 → OFF", () => {
  for (const v of ["0", "false", "off", "no", "OFF", " No "]) {
    assert.equal(isBundleLarkCliEnabled(v), false, `${v} 应为 false`);
  }
});

test("run.js 相对路径指向 @larksuite/cli", () => {
  assert.equal(
    LARK_CLI_RUN_JS_RELATIVE,
    join("node_modules", "@larksuite", "cli", "scripts", "run.js"),
  );
});

test("bundle=false 只写占位文件,不联网", () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-stage-"));
  try {
    const r = stageLarkCli({ cwd: dir, bundle: false });
    assert.equal(r.bundled, false);
    assert.ok(existsSync(join(r.stageDir, "DISABLED.txt")));
    assert.match(readFileSync(join(r.stageDir, "DISABLED.txt"), "utf8"), /QINGAGENT_BUNDLE_LARK_CLI=1/);
    // 不应有 run.js
    assert.equal(existsSync(join(r.stageDir, LARK_CLI_RUN_JS_RELATIVE)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
