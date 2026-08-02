import assert from "node:assert/strict";
import { test } from "node:test";
import type { UpdateStatusPayload } from "./updateTypes.js";
import {
  UpdateStatusDispatcher,
  type UpdateStatusWindow,
} from "./updateStatusDispatcher.js";

function fakeWindow() {
  let destroyed = false;
  let contentsDestroyed = false;
  const received: UpdateStatusPayload[] = [];
  const window: UpdateStatusWindow = {
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => contentsDestroyed,
      send: (_channel, payload) => received.push(payload),
    },
  };
  return {
    window,
    received,
    destroy: () => {
      destroyed = true;
    },
    destroyContents: () => {
      contentsDestroyed = true;
    },
  };
}

test("首窗销毁后 update-downloaded 状态只发送给新窗口", () => {
  const dispatcher = new UpdateStatusDispatcher();
  const first = fakeWindow();
  const second = fakeWindow();
  dispatcher.setWindow(first.window);
  first.destroy();
  dispatcher.setWindow(second.window);

  const downloaded: UpdateStatusPayload = {
    kind: "soft-ready",
    version: "2.0.0",
    notesUrl: "https://example.com/releases",
  };
  dispatcher.dispatch(downloaded);

  assert.deepEqual(first.received, []);
  assert.deepEqual(second.received, [downloaded]);
});

test("关窗期间到达的重要状态在新窗口注册后重放一次，同窗口二次注册仍保留缓存", () => {
  const dispatcher = new UpdateStatusDispatcher();
  const first = fakeWindow();
  dispatcher.setWindow(first.window);
  first.destroy();

  const downloaded: UpdateStatusPayload = {
    kind: "soft-ready",
    version: "2.1.0",
    notesUrl: "https://example.com/releases",
  };
  dispatcher.dispatch(downloaded);
  const second = fakeWindow();
  dispatcher.setWindow(second.window);
  dispatcher.setWindow(second.window);

  assert.deepEqual(first.received, []);
  assert.deepEqual(second.received, [downloaded]);
  assert.deepEqual(dispatcher.getStatus(), downloaded);
});

test("窗口尚在但 webContents 已销毁时不发送也不抛异常", () => {
  const dispatcher = new UpdateStatusDispatcher();
  const current = fakeWindow();
  dispatcher.setWindow(current.window);
  current.destroyContents();

  assert.doesNotThrow(() => dispatcher.dispatch({ kind: "none" }));
  assert.deepEqual(current.received, []);
});

test("生命周期检查后 send 仍报告 Object has been destroyed 时旁路通知不拖垮主进程", () => {
  const dispatcher = new UpdateStatusDispatcher();
  dispatcher.setWindow({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: () => {
        throw new TypeError("Object has been destroyed");
      },
    },
  });

  assert.doesNotThrow(() => dispatcher.dispatch({ kind: "none" }));
});

test("未缓存重要状态时查询返回中性 none", () => {
  const dispatcher = new UpdateStatusDispatcher();
  assert.deepEqual(dispatcher.getStatus(), { kind: "none" });

  dispatcher.dispatch({ kind: "error" });
  assert.deepEqual(dispatcher.getStatus(), { kind: "none" });
});
