import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRendererConsoleLine,
  parseConsoleMessageArgs,
  truncateRendererLine,
} from "./rendererLog.js";

test("parseConsoleMessageArgs 兼容 Electron 35+ 的详情事件对象", () => {
  assert.deepEqual(
    parseConsoleMessageArgs([{
      level: "warning",
      message: "渲染警告",
      sourceId: "app.js",
      lineNumber: 12,
    }]),
    {
      level: "warning",
      message: "渲染警告",
      sourceId: "app.js",
      lineNumber: 12,
    },
  );
});

test("parseConsoleMessageArgs 保留 Electron 旧位置参数兼容", () => {
  assert.deepEqual(
    parseConsoleMessageArgs([3, "渲染错误", 8, "legacy.js"]),
    {
      level: "error",
      message: "渲染错误",
      sourceId: "legacy.js",
      lineNumber: 8,
    },
  );
});

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
