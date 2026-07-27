import { describe, expect, it, vi } from "vitest";
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

  it("租约首次读取受限时降级到标签内锁并继续发送", async () => {
    const storage = createStorage();
    storage.getItem = () => {
      throw new Error("storage unavailable");
    };
    const send = vi.fn(() => "sent");
    const manager = createLocalStorageLeaseLockManager({
      storage,
      settleMs: 0,
    });

    await expect(
      manager.request(
        "get-failed",
        { mode: "exclusive", ifAvailable: true },
        (lock) => {
          expect(lock).not.toBeNull();
          return send();
        },
      ),
    ).resolves.toBe("sent");
    expect(send).toHaveBeenCalledOnce();
  });

  it("租约写入受限时降级到标签内锁并继续发送", async () => {
    const storage = createStorage();
    storage.setItem = () => {
      throw new Error("storage unavailable");
    };
    const send = vi.fn(() => "sent");
    const manager = createLocalStorageLeaseLockManager({
      storage,
      settleMs: 0,
    });

    await expect(
      manager.request(
        "set-failed",
        { mode: "exclusive", ifAvailable: true },
        (lock) => {
          expect(lock).not.toBeNull();
          return send();
        },
      ),
    ).resolves.toBe("sent");
    expect(send).toHaveBeenCalledOnce();
  });

  it("租约确认读取受限时降级到标签内锁并继续发送", async () => {
    const storage = createStorage();
    const readLease = storage.getItem.bind(storage);
    let readCount = 0;
    storage.getItem = (key) => {
      readCount += 1;
      if (readCount === 2) throw new Error("storage unavailable");
      return readLease(key);
    };
    const send = vi.fn(() => "sent");
    const manager = createLocalStorageLeaseLockManager({
      storage,
      settleMs: 0,
    });

    await expect(
      manager.request(
        "confirm-read-failed",
        { mode: "exclusive", ifAvailable: true },
        (lock) => {
          expect(lock).not.toBeNull();
          return send();
        },
      ),
    ).resolves.toBe("sent");
    expect(readCount).toBe(2);
    expect(send).toHaveBeenCalledOnce();
  });

  it("写入后确认前已经超期时不确认持有并允许其他标签接管", async () => {
    const storage = createStorage();
    const storeLease = storage.setItem.bind(storage);
    let time = 1_000;
    storage.setItem = (key, value) => {
      storeLease(key, value);
      time = 1_100;
    };
    const expiredManager = createLocalStorageLeaseLockManager({
      storage,
      now: () => time,
      leaseMs: 100,
      settleMs: 0,
      createOwnerId: () => "tab-expired-before-confirm",
    });

    await expect(
      expiredManager.request(
        "expired-before-confirm",
        { mode: "exclusive", ifAvailable: true },
        (lock) => lock?.name ?? null,
      ),
    ).resolves.toBeNull();

    storage.setItem = storeLease;
    const takeoverManager = createLocalStorageLeaseLockManager({
      storage,
      now: () => time,
      leaseMs: 100,
      settleMs: 0,
      createOwnerId: () => "tab-takeover",
    });
    await expect(
      takeoverManager.request(
        "expired-before-confirm",
        { mode: "exclusive", ifAvailable: true },
        (lock) => lock?.name ?? null,
      ),
    ).resolves.toBe("expired-before-confirm");
  });

  it("另一标签接管后旧持有者的迟到心跳不得夺回租约", async () => {
    const storage = createStorage();
    let time = 1_000;
    let heartbeat!: () => void;
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
      createOwnerId: () => "tab-late-heartbeat",
      startHeartbeat: (callback) => {
        heartbeat = callback;
        return () => undefined;
      },
    });

    const running = manager.request(
      "late-heartbeat",
      { mode: "exclusive" },
      async () => {
        await gate;
      },
    );
    await Promise.resolve();
    const key = crossTabLeaseStorageKey("late-heartbeat");
    expect(JSON.parse(storage.values.get(key) ?? "null")).toMatchObject({
      expiresAt: 1_090,
    });

    time = 1_091;
    let finishTakeover!: () => void;
    let takeoverStarted!: () => void;
    const takeoverGate = new Promise<void>((resolve) => {
      finishTakeover = resolve;
    });
    const takeoverEntered = new Promise<void>((resolve) => {
      takeoverStarted = resolve;
    });
    const takeoverManager = createLocalStorageLeaseLockManager({
      storage,
      now: () => time,
      leaseMs: 90,
      heartbeatMs: 30,
      settleMs: 0,
      createOwnerId: () => "tab-takeover",
      startHeartbeat: () => () => undefined,
    });
    const takeover = takeoverManager.request(
      "late-heartbeat",
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        expect(lock).not.toBeNull();
        takeoverStarted();
        await takeoverGate;
      },
    );
    await takeoverEntered;
    expect(JSON.parse(storage.values.get(key) ?? "null")).toMatchObject({
      ownerId: "tab-takeover",
      expiresAt: 1_181,
    });

    heartbeat();
    expect(JSON.parse(storage.values.get(key) ?? "null")).toMatchObject({
      ownerId: "tab-takeover",
      expiresAt: 1_181,
    });

    finish();
    await running;
    expect(JSON.parse(storage.values.get(key) ?? "null")).toMatchObject({
      ownerId: "tab-takeover",
      expiresAt: 1_181,
    });

    finishTakeover();
    await takeover;
    expect(storage.values.has(key)).toBe(false);
  });
});
