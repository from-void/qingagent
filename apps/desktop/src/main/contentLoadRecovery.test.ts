import assert from "node:assert/strict";
import { test } from "node:test";
import { nextContentLoadRecoveryStep } from "./contentLoadRecovery.js";

test("内容页恢复最多重试三次并按 1s、2s、4s 指数退避", () => {
  assert.deepEqual(nextContentLoadRecoveryStep(0), {
    kind: "retry",
    attempt: 1,
    delayMs: 1_000,
  });
  assert.deepEqual(nextContentLoadRecoveryStep(1), {
    kind: "retry",
    attempt: 2,
    delayMs: 2_000,
  });
  assert.deepEqual(nextContentLoadRecoveryStep(2), {
    kind: "retry",
    attempt: 3,
    delayMs: 4_000,
  });
});

test("三次重试耗尽后进入用户选择终态", () => {
  assert.deepEqual(nextContentLoadRecoveryStep(3), { kind: "prompt" });
  assert.deepEqual(nextContentLoadRecoveryStep(99), { kind: "prompt" });
});
