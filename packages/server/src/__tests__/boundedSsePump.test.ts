import { describe, expect, it, vi } from "vitest";
import { BoundedSsePump } from "../lib/boundedSsePump";
import { allowOversizedSseFrame } from "../lib/terminalDocumentFrame";
import type { BridgeFrame } from "@qingagent/contract-ts";

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

    expect(pump.enqueue({ id: "41", event: "frame", data: "in-flight" })).toBe(true);
    await Promise.resolve();
    for (let index = 0; index < 100; index += 1) {
      pump.enqueue({ id: String(42 + index), event: "frame", data: `queued-${index}` });
    }

    expect(pump.stats()).toMatchObject({
      queuedFrames: 0,
      queuedBytes: 0,
      pumping: true,
      closed: true,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("overflow", expect.objectContaining({
      reason: "overflow",
      queuedFrames: 4,
      queuedBytes: expect.any(Number),
      lastWrittenSeq: null,
      firstUnwrittenSeq: "41",
      attemptedSeq: "45",
      attemptedBytes: expect.any(Number),
    }));

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

  it.each([
    {
      label: "generation_finished",
      frame: {
        kind: "docGenerationEvent",
        data: {
          kind: "generation_finished",
          data: {
            generationId: "g-large",
            seq: 2,
            prevSeq: 1,
            doc: {
              type: "doc",
              attrs: { schemaVersion: 1 },
              content: [],
            },
            finalVersion: 7,
            contentHash: "hash-large",
          },
        },
      } as BridgeFrame,
    },
    {
      label: "stream end finalDocument",
      frame: {
        kind: "stream",
        data: {
          kind: "end",
          data: {
            streamId: "s-large",
            reason: { kind: "done" },
            finalDocument: {
              version: 7,
              contentHash: "hash-large",
              doc: {
                type: "doc",
                attrs: { schemaVersion: 1 },
                content: [],
              },
            },
          },
        },
      } as BridgeFrame,
    },
  ])("$label 与普通快照一样绕过合法大帧字节门", async ({ frame }) => {
    const writes: string[] = [];
    const onClose = vi.fn();
    const pump = new BoundedSsePump({
      write: async (message) => { writes.push(message.data); },
      onClose,
      maxBytes: 512 * 1024,
    });
    const oversizedFrame = structuredClone(frame);
    if (oversizedFrame.kind === "docGenerationEvent" && oversizedFrame.data.kind === "generation_finished") {
      oversizedFrame.data.data.doc.content = [{
        type: "paragraph",
        attrs: { blockId: "large-generation" },
        content: [{ type: "text", text: "大".repeat(300 * 1024) }],
      }];
    } else if (
      oversizedFrame.kind === "stream" &&
      oversizedFrame.data.kind === "end" &&
      oversizedFrame.data.data.finalDocument
    ) {
      oversizedFrame.data.data.finalDocument.doc.content = [{
        type: "paragraph",
        attrs: { blockId: "large-receipt" },
        content: [{ type: "text", text: "大".repeat(300 * 1024) }],
      }];
    }
    const data = JSON.stringify(oversizedFrame);
    expect(Buffer.byteLength(data, "utf8")).toBeGreaterThan(512 * 1024);
    expect(allowOversizedSseFrame(oversizedFrame)).toBe(true);
    expect(pump.enqueue(
      { id: "99", event: "frame", data },
      { allowOversized: allowOversizedSseFrame(oversizedFrame) },
    )).toBe(true);
    await pump.waitForIdle();
    expect(writes).toEqual([data]);
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
