import { describe, expect, it } from "vitest";
import {
  createLocalStorageLeaseLockManager,
  crossTabLeaseStorageKey,
  type CrossTabLeaseStorage,
} from "./crossTabLock";

function createStorage(): CrossTabLeaseStorage & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe("localStorage 跨标签租约锁", () => {
  it("无 Web Locks 时互斥执行且等待者会在释放后继续发送", async () => {
    const storage = createStorage();
    const firstManager = createLocalStorageLeaseLockManager({
      storage,
      settleMs: 0,
      retryMs: 1,
      createOwnerId: () => "tab-first",
    });
    const secondManager = createLocalStorageLeaseLockManager({
      storage,
      settleMs: 0,
      retryMs: 1,
      createOwnerId: () => "tab-second",
    });
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = firstManager.request(
      "first-submit",
      { mode: "exclusive" },
      async () => {
        calls.push("first");
        await firstGate;
        return true;
      },
    );
    await Promise.resolve();
    const second = secondManager.request(
      "first-submit",
      { mode: "exclusive" },
      () => {
        calls.push("second");
        return true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(calls).toEqual(["first"]);
    expect(
      JSON.parse(
        storage.values.get(crossTabLeaseStorageKey("first-submit")) ??
          "null",
      ),
    ).toMatchObject({ ownerId: "tab-first" });

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      true,
      true,
    ]);
    expect(calls).toEqual(["first", "second"]);
  });

  it("持有期间心跳延长租约", async () => {
    const storage = createStorage();
    let time = 1_000;
    let heartbeat!: () => void;
    let stopCalled = false;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const manager = createLocalStorageLeaseLockManager({
      storage,
      now: () => time,
      leaseMs: 90,
      heartbeatMs: 30,
      settleMs: 0,
      createOwnerId: () => "tab-heartbeat",
      startHeartbeat: (callback) => {
        heartbeat = callback;
        return () => {
          stopCalled = true;
        };
      },
    });

    const running = manager.request(
      "heartbeat",
      { mode: "exclusive" },
      async () => {
        await gate;
      },
    );
    await Promise.resolve();
    const key = crossTabLeaseStorageKey("heartbeat");
    expect(JSON.parse(storage.values.get(key) ?? "null")).toMatchObject({
      ownerId: "tab-heartbeat",
      expiresAt: 1_090,
    });

    time = 1_060;
    heartbeat();
    expect(JSON.parse(storage.values.get(key) ?? "null")).toMatchObject({
      expiresAt: 1_150,
    });

    finish();
    await running;
    expect(stopCalled).toBe(true);
    expect(storage.values.has(key)).toBe(false);
  });
});
