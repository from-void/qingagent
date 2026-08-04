import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasOtherProcessErrorHandler } from "./processErrorPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("安装时无其他 handler、触发时 crashGuard 已安装时由 crashGuard 接管", () => {
  assert.equal(hasOtherProcessErrorHandler(2), true);
});

test("触发时只有 telemetry 自身时走退出分支", () => {
  assert.equal(hasOtherProcessErrorHandler(1), false);
});

test("两类 telemetry handler 都在触发时读取实时监听器数量", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const handlerSource = source.slice(
    source.indexOf("function installTelemetryProcessErrorHandlers()"),
    source.indexOf("function consumeTrustedRememberGesture("),
  );

  assert.doesNotMatch(handlerSource, /existingUncaughtExceptionListeners|existingUnhandledRejectionListeners/);
  assert.equal(
    handlerSource.match(/hasOtherProcessErrorHandler\(process\.listenerCount\("uncaughtException"\)\)/g)?.length,
    1,
  );
  assert.equal(
    handlerSource.match(/hasOtherProcessErrorHandler\(process\.listenerCount\("unhandledRejection"\)\)/g)?.length,
    1,
  );
});
