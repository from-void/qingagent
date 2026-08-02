// awaitWithinMs 回归测试:退出预算封顶等待——挂死的 promise 不能拖过预算(修 shutdown 被
// 单次 8s fetch 拖过 2s 退出预算的问题);正常完成的 promise 不等满预算;拒绝不抛。
import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitWithinMs } from "./deadline.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("挂死的 promise 在预算内先行返回", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hang = createDeferred();
  let settled = false;
  const completion = awaitWithinMs(hang.promise, 100).then(() => {
    settled = true;
  });

  try {
    t.mock.timers.tick(99);
    await Promise.resolve();
    assert.equal(settled, false);

    t.mock.timers.tick(1);
    await completion;
    assert.equal(settled, true);
  } finally {
    hang.resolve();
    await Promise.allSettled([hang.promise, completion]);
  }
});

test("先完成的 promise 不等满预算", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await awaitWithinMs(Promise.resolve("ok"), 5000);
});

test("拒绝的 promise 被吞掉不抛(埋点错误不能影响退出)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await awaitWithinMs(Promise.reject(new Error("boom")), 1000);
});

test("预算 <=0 立即返回且不抛", async () => {
  const hang = createDeferred();
  try {
    await awaitWithinMs(hang.promise, 0);
    await awaitWithinMs(hang.promise, -5);
  } finally {
    hang.resolve();
    await hang.promise;
  }
});
