import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingStore, PendingStoreError } from "../pendingStore.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("PendingStore", () => {
  it("pendingId 不可猜、connector/scope 绑定且重复 start 单飞复用", () => {
    const store = new PendingStore<{ secret: string }>();
    let creates = 0;
    const create = () => {
      creates += 1;
      return { secret: "device-code" };
    };
    const first = store.start({ connectorId: "github", scope: "public", create });
    const second = store.start({ connectorId: "github", scope: "public", create });

    expect(first.entry.pendingId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second.entry.pendingId).toBe(first.entry.pendingId);
    expect(second.reused).toBe(true);
    expect(creates).toBe(1);
    expect(() => store.get(first.entry.pendingId, "github", "private")).toThrowError(
      expect.objectContaining({ code: "PENDING_LOST", status: 410 }),
    );
    store.shutdown();
  });

  it("TTL 到期 abort 并返回 PENDING_LOST；到期边界主动 get 返回 PENDING_EXPIRED", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const store = new PendingStore<string>({ ttlMs: 100, now: () => now });
    const started = store.start({ connectorId: "github", scope: "public", create: () => "secret" });
    now = 1_100;
    expect(() => store.get(started.entry.pendingId, "github", "public")).toThrowError(
      expect.objectContaining({ code: "PENDING_EXPIRED", status: 410 }),
    );
    expect(started.entry.signal.aborted).toBe(true);

    const timerEntry = store.start({
      connectorId: "github",
      scope: "public",
      create: () => "secret-2",
    }).entry;
    vi.advanceTimersByTime(100);
    expect(timerEntry.signal.aborted).toBe(true);
    expect(() => store.get(timerEntry.pendingId, "github", "public")).toThrowError(
      expect.objectContaining({ code: "PENDING_LOST", status: 410 }),
    );
  });

  it("续期原位更新唯一 expiresAt，旧定时器不再提前清理", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const store = new PendingStore<string>({ ttlMs: 100, now: () => now });
    const started = store.start({
      connectorId: "wechat-mp",
      scope: "default",
      create: () => "qr",
    }).entry;

    vi.advanceTimersByTime(50);
    now = 1_050;
    const renewed = store.renew(
      started.pendingId,
      "wechat-mp",
      "default",
    );
    expect(renewed.expiresAt).toBe(1_150);

    vi.advanceTimersByTime(50);
    now = 1_100;
    expect(renewed.signal.aborted).toBe(false);
    expect(store.current("wechat-mp", "default")?.expiresAt).toBe(1_150);

    vi.advanceTimersByTime(50);
    now = 1_150;
    expect(renewed.signal.aborted).toBe(true);
    expect(store.current("wechat-mp", "default")).toBeNull();
  });

  it("容量上限、disconnect 与 shutdown 均清理并 abort", () => {
    const store = new PendingStore<string>({ capacity: 2 });
    const first = store.start({ connectorId: "github", scope: "a", create: () => "a" }).entry;
    const second = store.start({ connectorId: "feishu", scope: "b", create: () => "b" }).entry;
    expect(() =>
      store.start({ connectorId: "wechat-mp", scope: "c", create: () => "c" }),
    ).toThrowError(expect.objectContaining({ code: "PENDING_CAPACITY", status: 429 }));

    expect(store.disconnect("github", "a")).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(store.disconnect("github", "a")).toBe(false);
    store.shutdown();
    expect(second.signal.aborted).toBe(true);
    expect(store.size).toBe(0);
  });

  it("cancel 必须匹配 pendingId 与绑定，并只中止目标授权", () => {
    const store = new PendingStore<string>();
    const first = store.start({
      connectorId: "github",
      scope: "public",
      create: () => "first",
    }).entry;
    const second = store.start({
      connectorId: "feishu",
      scope: "docs",
      create: () => "second",
    }).entry;

    expect(() => store.cancel(first.pendingId, "github", "private")).toThrowError(
      expect.objectContaining({ code: "PENDING_LOST", status: 410 }),
    );
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);

    expect(store.cancel(first.pendingId, "github", "public")).toMatchObject({
      pendingId: first.pendingId,
    });
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(store.current("github", "public")).toBeNull();
    expect(store.current("feishu", "docs")?.pendingId).toBe(second.pendingId);
    store.shutdown();
  });

  it("进程退出钩子调用 shutdown，detach 后不再响应", () => {
    const emitter = new EventEmitter();
    const processLike = emitter as unknown as Pick<NodeJS.Process, "once" | "off">;
    const store = new PendingStore<string>();
    const first = store.start({ connectorId: "github", scope: "a", create: () => "a" }).entry;
    const detach = store.attachProcessCleanup(processLike);
    emitter.emit("exit", 0);
    expect(first.signal.aborted).toBe(true);

    const second = store.start({ connectorId: "github", scope: "a", create: () => "b" }).entry;
    detach();
    emitter.emit("exit", 0);
    expect(second.signal.aborted).toBe(false);
    store.shutdown();
  });

  it("未知 pendingId（含进程重启/错误 owner）稳定为 410 PENDING_LOST", () => {
    const restartedStore = new PendingStore<string>();
    try {
      restartedStore.get("old-card-pending-id", "github", "public");
    } catch (error) {
      expect(error).toBeInstanceOf(PendingStoreError);
      expect(error).toMatchObject({ code: "PENDING_LOST", status: 410 });
    }
  });
});
