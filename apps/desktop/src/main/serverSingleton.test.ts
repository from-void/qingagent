import assert from "node:assert/strict";
import { test } from "node:test";
import { createSingleFlightStarter } from "./serverSingleton.js";

test("重复调用 embedded server 启动包装器只启动一次并复用同一端口", async () => {
  let starts = 0;
  const startServer = createSingleFlightStarter(async () => {
    starts += 1;
    await Promise.resolve();
    return { port: 43123 };
  });

  const [first, second, third] = await Promise.all([
    startServer({ desktopLogDir: "/tmp/first" }),
    startServer({ desktopLogDir: "/tmp/second" }),
    startServer({ desktopLogDir: "/tmp/third" }),
  ]);

  assert.equal(starts, 1);
  assert.strictEqual(first, second);
  assert.strictEqual(second, third);
  assert.equal(first.port, 43123);
});
