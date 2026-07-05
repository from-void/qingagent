// awaitWithinMs 回归测试:退出预算封顶等待——挂死的 promise 不能拖过预算(修 shutdown 被
// 单次 8s fetch 拖过 2s 退出预算的问题);正常完成的 promise 不等满预算;拒绝不抛。
import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitWithinMs } from "./deadline.js";

test("挂死的 promise 在预算内先行返回", async () => {
  const hang = new Promise(() => {});
  const start = Date.now();
  await awaitWithinMs(hang, 100);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 80 && elapsed < 1000, `elapsed=${elapsed} 应约等于预算 100ms`);
});

test("先完成的 promise 不等满预算", async () => {
  const start = Date.now();
  await awaitWithinMs(Promise.resolve("ok"), 5000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `elapsed=${elapsed} 不应等满 5s 预算`);
});

test("拒绝的 promise 被吞掉不抛(埋点错误不能影响退出)", async () => {
  await awaitWithinMs(Promise.reject(new Error("boom")), 1000);
});

test("预算 <=0 立即返回且不抛", async () => {
  const hang = new Promise(() => {});
  const start = Date.now();
  await awaitWithinMs(hang, 0);
  await awaitWithinMs(hang, -5);
  assert.ok(Date.now() - start < 200);
});
