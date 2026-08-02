import assert from "node:assert/strict";
import { test } from "node:test";
import {
  destroyWindowIfAlive,
  getLiveWebContents,
  type DestroyableWebContents,
} from "./windowLifecycle.js";

test("窗口已销毁时不再读取 webContents getter", () => {
  const window = {
    isDestroyed: () => true,
    get webContents(): DestroyableWebContents {
      throw new TypeError("Object has been destroyed");
    },
  };

  assert.doesNotThrow(() => getLiveWebContents(window));
  assert.equal(getLiveWebContents(window), null);
});

test("窗口仍在但 webContents 已销毁时按不可用处理", () => {
  const contents: DestroyableWebContents = { isDestroyed: () => true };
  assert.equal(getLiveWebContents({ isDestroyed: () => false, webContents: contents }), null);
});

test("abort 与 finally 重复清理隐藏窗时只销毁一次", () => {
  let destroyed = false;
  let calls = 0;
  const window = {
    isDestroyed: () => destroyed,
    destroy: () => {
      if (destroyed) throw new TypeError("Object has been destroyed");
      destroyed = true;
      calls += 1;
    },
  };

  destroyWindowIfAlive(window);
  assert.doesNotThrow(() => destroyWindowIfAlive(window));
  assert.equal(calls, 1);
});
