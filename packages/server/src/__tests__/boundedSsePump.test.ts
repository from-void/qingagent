import { describe, expect, it, vi } from "vitest";
import { BoundedSsePump } from "../lib/boundedSsePump";

describe("BoundedSsePump", () => {
  it("慢 writer 下只保留有界帧引用，溢出即关闭而非线性增长 Promise 链", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const write = vi.fn(async () => blocked);
    const onClose = vi.fn();
    const pump = new BoundedSsePump({
      write,
      onClose,
      maxFrames: 3,
      maxBytes: 1024,
    });

    expect(pump.enqueue({ event: "frame", data: "in-flight" })).toBe(true);
    await Promise.resolve();
    for (let index = 0; index < 100; index += 1) {
      pump.enqueue({ event: "frame", data: `queued-${index}` });
    }

    expect(pump.stats()).toMatchObject({
      queuedFrames: 0,
      queuedBytes: 0,
      pumping: true,
      closed: true,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("overflow");

    release();
    await pump.waitForIdle();
    expect(pump.stats().pumping).toBe(false);
  });

  it("心跳与业务帧共用同一个 writer 顺序泵", async () => {
    const writes: string[] = [];
    const pump = new BoundedSsePump({
      write: async (message) => { writes.push(message.event ?? "message"); },
      onClose: vi.fn(),
    });

    pump.enqueue({ event: "frame", data: "{}" });
    pump.enqueue({ event: "ping", data: "{}" });
    await pump.waitForIdle();

    expect(writes).toEqual(["frame", "ping"]);
  });

  it("66+ 条同步历史回放不占 live 背压预算", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const writes: string[] = [];
    const onClose = vi.fn();
    const pump = new BoundedSsePump({
      write: async (message) => {
        writes.push(message.data);
        if (writes.length === 1) await blocked;
      },
      onClose,
      maxFrames: 64,
      maxBytes: 512 * 1024,
    });

    for (let index = 0; index < 70; index += 1) {
      expect(pump.enqueue({ event: "frame", data: `history-${index}` }, { delivery: "replay" })).toBe(true);
    }
    expect(pump.stats()).toMatchObject({ queuedFrames: 69, closed: false });
    expect(onClose).not.toHaveBeenCalled();

    release();
    await pump.waitForIdle();
    expect(writes).toHaveLength(70);
  });

  it("合法文档快照可超过 512 KiB，且后续小帧仍可入队", async () => {
    const writes: string[] = [];
    const onClose = vi.fn();
    const pump = new BoundedSsePump({
      write: async (message) => { writes.push(message.event ?? "message"); },
      onClose,
      maxBytes: 512 * 1024,
    });

    expect(pump.enqueue(
      { event: "frame", data: "x".repeat(600 * 1024) },
      { allowOversized: true },
    )).toBe(true);
    expect(pump.enqueue({ event: "frame", data: "{}" })).toBe(true);
    await pump.waitForIdle();

    expect(writes).toEqual(["frame", "frame"]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("live 队列已满时丢心跳而不关闭连接", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const onClose = vi.fn();
    const pump = new BoundedSsePump({
      write: async () => blocked,
      onClose,
      maxFrames: 1,
    });

    pump.enqueue({ event: "frame", data: "in-flight" });
    await Promise.resolve();
    pump.enqueue({ event: "frame", data: "queued" });
    expect(pump.enqueue(
      { event: "ping", data: "{}" },
      { dropOnOverflow: true },
    )).toBe(false);
    expect(pump.stats().closed).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    release();
    await pump.waitForIdle();
  });
});
