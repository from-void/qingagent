import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("desktop main only touches @qingagent/core barrel after server startup", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const lines = source.split(/\r?\n/);

  const firstCoreBarrelLine = findLine(lines, 'import("@qingagent/core")');
  const startServerLine = findLine(lines, "await startServer(");

  assert.notEqual(firstCoreBarrelLine, -1, "需要保留一个迁移后的 @qingagent/core barrel 导入作为回归哨兵");
  assert.notEqual(startServerLine, -1, "未找到 server 启动调用");
  assert.ok(
    firstCoreBarrelLine > startServerLine,
    `@qingagent/core barrel 首次导入必须晚于 server 启动: barrel=${firstCoreBarrelLine + 1}, startServer=${startServerLine + 1}`,
  );
});

function findLine(lines: string[], marker: string): number {
  return lines.findIndex((line) => line.includes(marker));
}
