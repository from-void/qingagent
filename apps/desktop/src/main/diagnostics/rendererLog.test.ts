import assert from "node:assert/strict";
import test from "node:test";
import { formatRendererConsoleLine, truncateRendererLine } from "./rendererLog.js";

test("formatRendererConsoleLine 输出 renderer console 行格式", () => {
  assert.equal(
    formatRendererConsoleLine({
      level: "warning",
      message: "渲染警告",
      sourceId: "app.js",
      lineNumber: 12,
    }),
    "rendererConsole level=warning source=app.js line=12 message=渲染警告",
  );
});

test("truncateRendererLine 截断到 2000 字符", () => {
  const line = truncateRendererLine("x".repeat(2100));

  assert.equal(line.length, 2000);
  assert.equal(line.endsWith("[truncated]"), true);
});
