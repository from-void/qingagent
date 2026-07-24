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
});
