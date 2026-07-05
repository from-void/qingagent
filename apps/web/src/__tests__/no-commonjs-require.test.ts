import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// 回归守卫(审计批次1):浏览器 ESM 产物里出现 CommonJS require() 必抛
// ReferenceError;若再被空 catch 包住就是静默失效——曾在
// DocumentSnapshotView.tsx 表格「AI 修改」推送聊天处真实发生过。
// 这里整树扫描 src,禁止任何运行时 require( 调用再次进入 web 前端代码。

const SRC_ROOT = join(__dirname, "..");
// 匹配裸 require( 调用;注释里复述案情的文字(如"原是 require()——")不算调用。
const REQUIRE_CALL = /(?<![\w.])require\s*\(\s*["'`]/;

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("web 前端源码不允许 CommonJS require()", () => {
  it("src 下所有 ts/tsx 无运行时 require( 调用", () => {
    const offenders = collectSourceFiles(SRC_ROOT).filter((file) =>
      REQUIRE_CALL.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
