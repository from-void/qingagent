import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_DESKTOP_PORT,
  listenWithDesktopPortFallback,
  resolveDesktopPort,
} from "./desktopPort.js";

test("桌面端口默认固定，且允许环境变量覆盖", () => {
  assert.equal(resolveDesktopPort(undefined), DEFAULT_DESKTOP_PORT);
  assert.equal(resolveDesktopPort(""), DEFAULT_DESKTOP_PORT);
  assert.equal(resolveDesktopPort("43127"), 43127);
  assert.equal(resolveDesktopPort("0"), 0);
  assert.equal(resolveDesktopPort("not-a-port"), DEFAULT_DESKTOP_PORT);
  assert.equal(resolveDesktopPort("65536"), DEFAULT_DESKTOP_PORT);
});

test("固定端口被占用时仅回退一次随机端口", async () => {
  const attempts: number[] = [];
  const result = await listenWithDesktopPortFallback(DEFAULT_DESKTOP_PORT, async (port) => {
    attempts.push(port);
    if (port === DEFAULT_DESKTOP_PORT) {
      throw Object.assign(new Error("address already in use"), { code: "EADDRINUSE" });
    }
    return 53142;
  });

  assert.deepEqual(attempts, [DEFAULT_DESKTOP_PORT, 0]);
  assert.deepEqual(result, { port: 53142, fellBack: true });
});

test("非端口占用错误不回退", async () => {
  const expected = Object.assign(new Error("permission denied"), { code: "EACCES" });
  await assert.rejects(
    listenWithDesktopPortFallback(DEFAULT_DESKTOP_PORT, async () => {
      throw expected;
    }),
    (error) => error === expected,
  );
});
