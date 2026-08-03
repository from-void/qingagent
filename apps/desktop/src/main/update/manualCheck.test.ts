import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  runManualCheck,
  resetManualCheckInflightForTest,
  type CheckableUpdater,
  type ManualCheckDeps,
} from "./manualCheck.js";
import type { UpdatePolicy } from "./policy.js";

type Listener = (...args: unknown[]) => void;

// 最小假 updater:once/removeListener/checkForUpdates,配合 emit 手动触发事件。
class FakeUpdater implements CheckableUpdater {
  listeners = new Map<string, Set<Listener>>();
  checkCalls = 0;
  checkResult: unknown = null;
  // checkForUpdates 被调用后自动 emit 的事件(模拟底层检查回来)。null = 不自动 emit。
  autoEmit: { event: string; info?: unknown } | null = null;

  once(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }
  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1;
    if (this.autoEmit) {
      const { event, info } = this.autoEmit;
      queueMicrotask(() => this.emit(event, info));
    }
    return this.checkResult;
  }
  emit(event: string, info?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(info);
  }
}

class ThrowingUpdater extends FakeUpdater {
  constructor(private readonly checkError: unknown) {
    super();
  }

  override checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1;
    throw this.checkError;
  }
}

const noPolicy = async (): Promise<UpdatePolicy> => ({ minSupported: null });

function baseDeps(updater: CheckableUpdater, over: Partial<ManualCheckDeps> = {}): ManualCheckDeps {
  return {
    updater,
    platform: "win32",
    appVersion: "1.2.3",
    isPackaged: true,
    fetchPolicy: noPolicy,
    timeoutMs: 50,
    ...over,
  };
}

async function waitForCheckCall(updater: FakeUpdater): Promise<void> {
  for (let attempt = 0; attempt < 10 && updater.checkCalls === 0; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(updater.checkCalls, 1, "checkForUpdates 应在微任务阶段启动");
}

beforeEach(() => resetManualCheckInflightForTest());

test("dev 短路:未打包直接 none,不触发底层检查", async () => {
  const updater = new FakeUpdater();
  const result = await runManualCheck(baseDeps(updater, { isPackaged: false }));
  assert.deepEqual(result, { kind: "none" });
  assert.equal(updater.checkCalls, 0);
});

test("dev 短路:-dev. 版本直接 none,不触发底层检查", async () => {
  const updater = new FakeUpdater();
  const result = await runManualCheck(baseDeps(updater, { appVersion: "1.2.3-dev.5" }));
  assert.deepEqual(result, { kind: "none" });
  assert.equal(updater.checkCalls, 0);
});

test("error 事件 → 返回 error 态(区分于已是最新)", async () => {
  const updater = new FakeUpdater();
  updater.autoEmit = { event: "error", info: new Error("network down") };
  const result = await runManualCheck(baseDeps(updater));
  assert.equal(result.kind, "error");
});

test("checkForUpdates 同步抛 ENOENT 时收敛为 error 态", async () => {
  const enoent = Object.assign(new Error("ENOENT: app-update.yml"), { code: "ENOENT" });
  const updater = new ThrowingUpdater(enoent);
  const reported: unknown[] = [];

  const result = await runManualCheck(
    baseDeps(updater, { onCheckError: (error) => reported.push(error) }),
  );

  assert.equal(result.kind, "error");
  assert.deepEqual(reported, [enoent]);
  assert.equal(updater.checkCalls, 1);
});

test("自动下载读取 app-update.yml 抛 ENOENT 时不产生 unhandledRejection", async () => {
  const updater = new FakeUpdater();
  const enoent = Object.assign(
    new Error("ENOENT: no such file or directory, open 'resources/app-update.yml'"),
    { code: "ENOENT" },
  );
  updater.checkResult = { downloadPromise: Promise.reject(enoent) };
  updater.autoEmit = { event: "update-available", info: { version: "1.3.0" } };
  const unhandled: unknown[] = [];
  const reported: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    const result = await runManualCheck(
      baseDeps(updater, { onCheckError: (error) => reported.push(error) }),
    );
    assert.equal(result.kind, "soft-available");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(reported, [enoent]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("检查超时 → 返回 error 态(不假报已是最新)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updater = new FakeUpdater(); // 不自动 emit,靠 timeoutMs 兜底
  let settled = false;
  const pendingResult = runManualCheck(
    baseDeps(updater, { timeoutMs: 1_000 }),
  ).then((result) => {
    settled = true;
    return result;
  });

  await waitForCheckCall(updater);
  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.equal(settled, false);

  t.mock.timers.tick(1);
  assert.equal((await pendingResult).kind, "error");
});

test("update-not-available → none(已是最新)", async () => {
  const updater = new FakeUpdater();
  updater.autoEmit = { event: "update-not-available" };
  const result = await runManualCheck(baseDeps(updater));
  assert.deepEqual(result, { kind: "none" });
});

test("win/linux 发现新版 → soft-available 带版本号", async () => {
  const updater = new FakeUpdater();
  updater.autoEmit = { event: "update-available", info: { version: "1.3.0" } };
  const result = await runManualCheck(baseDeps(updater, { platform: "linux" }));
  assert.equal(result.kind, "soft-available");
  assert.equal(result.version, "1.3.0");
});

test("mac 发现新版 → mac-manual(不自动下载,前往下载页)", async () => {
  const updater = new FakeUpdater();
  updater.autoEmit = { event: "update-available", info: { version: "1.3.0" } };
  const result = await runManualCheck(baseDeps(updater, { platform: "darwin" }));
  assert.equal(result.kind, "mac-manual");
  assert.equal(result.version, "1.3.0");
});

test("强更分流:低于最低支持版本 → force,并推送让 Modal 接管", async () => {
  const updater = new FakeUpdater();
  const pushed: string[] = [];
  const result = await runManualCheck(
    baseDeps(updater, {
      appVersion: "1.0.0",
      fetchPolicy: async () => ({ minSupported: "1.2.0" }),
      onStatus: (p) => pushed.push(p.kind),
    }),
  );
  assert.equal(result.kind, "force");
  assert.equal(result.version, "1.2.0");
  assert.deepEqual(pushed, ["force"]);
  // 强更直接分流,不再触发底层检查。
  assert.equal(updater.checkCalls, 0);
});

test("并发去重:检查中再次点击复用同一 Promise,底层只检查一次", async () => {
  const updater = new FakeUpdater(); // 手动控制何时 emit
  const p1 = runManualCheck(baseDeps(updater));
  const p2 = runManualCheck(baseDeps(updater));
  assert.equal(p1, p2, "并发调用应返回同一进行中的 Promise");
  // 等 doRun 走到 awaitCheckResult 挂好监听并调过 checkForUpdates，再 emit。
  await waitForCheckCall(updater);
  updater.emit("update-not-available");
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, { kind: "none" });
  assert.deepEqual(r2, { kind: "none" });
  assert.equal(updater.checkCalls, 1);
});
