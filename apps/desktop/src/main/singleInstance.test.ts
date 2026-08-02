import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acquireSingleInstanceLock,
  type FocusableWindow,
  type SingleInstanceApp,
} from "./singleInstance.js";

function fakeApp(lockGranted: boolean) {
  let secondInstance: ((event: unknown, commandLine: string[]) => void) | undefined;
  let quitCalls = 0;
  const app: SingleInstanceApp = {
    requestSingleInstanceLock: () => lockGranted,
    quit: () => {
      quitCalls += 1;
    },
    on: (_event, listener) => {
      secondInstance = listener;
    },
  };
  return {
    app,
    get quitCalls() {
      return quitCalls;
    },
    emitSecondInstance: (commandLine: string[] = []) => secondInstance?.(undefined, commandLine),
  };
}

test("锁失败时立即退出且调用方不启动 ready/server 链", () => {
  const electron = fakeApp(false);
  let startupCalls = 0;

  const acquired = acquireSingleInstanceLock(electron.app, () => null);
  if (acquired) startupCalls += 1;

  assert.equal(acquired, false);
  assert.equal(electron.quitCalls, 1);
  assert.equal(startupCalls, 0);
});

test("锁成功后 second-instance 恢复并聚焦当前窗口", () => {
  const electron = fakeApp(true);
  const calls: string[] = [];
  const window: FocusableWindow = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    focus: () => calls.push("focus"),
  };

  const commandLines: string[][] = [];
  assert.equal(
    acquireSingleInstanceLock(
      electron.app,
      () => window,
      (commandLine) => commandLines.push(commandLine),
    ),
    true,
  );
  electron.emitSecondInstance([
    "qingagent.exe",
    "qingagent://app/#/workspace?session=second-instance",
  ]);

  assert.equal(electron.quitCalls, 0);
  assert.deepEqual(commandLines, [[
    "qingagent.exe",
    "qingagent://app/#/workspace?session=second-instance",
  ]]);
  assert.deepEqual(calls, ["restore", "focus"]);
});
