import { describe, expect, it } from "vitest";
import { aggregateFrameLogEntries, type FrameLogExportEntry } from "./frameAggregate";

describe("aggregateFrameLogEntries", () => {
  it("连续同 messageId 的 chatMessageAppended 合并,交错消息切段", () => {
    const entries = [
      chat(1, "m1", "text", "你好"),
      chat(2, "m1", "thinking", "想一下"),
      chat(3, "m2", "text", "中断"),
      chat(4, "m1", "text", "继续"),
      chat(5, "m1", "text", "完成"),
    ];

    const out = aggregateFrameLogEntries(entries) as FrameLogExportEntry[];

    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      seq: 1,
      epoch: 11,
      generation: 7,
      frame: {
        kind: "chatMessageAppended@merged",
        data: {
          messageId: "m1",
          frames: 2,
          seqFirst: 1,
          seqLast: 2,
          chars: 5,
          partKinds: ["text", "thinking"],
        },
      },
    });
    expect(out[1]?.frame.kind).toBe("chatMessageAppended");
    expect(out[2]).toMatchObject({
      frame: {
        kind: "chatMessageAppended@merged",
        data: { messageId: "m1", frames: 2, seqFirst: 4, seqLast: 5, chars: 4 },
      },
    });
  });

  it("单帧不聚合", () => {
    const entries = [chat(1, "m1", "text", "一")];

    expect(aggregateFrameLogEntries(entries)).toEqual(entries);
  });

  it("连续 documentSnapshotWritten 只保留段内末帧并在前面写折叠摘要", () => {
    const entries = [snapshot(1, "v1"), snapshot(2, "v2"), snapshot(3, "v3")];

    const out = aggregateFrameLogEntries(entries) as FrameLogExportEntry[];

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      frame: {
        kind: "documentSnapshotWritten@merged",
        data: { frames: 2, seqFirst: 1, seqLast: 2 },
      },
    });
    expect(out[1]).toEqual(entries[2]);
  });

  it("连续 docGenerationEvent 合并内部事件 kind 计数", () => {
    const entries = [
      docEvent(1, "generation_started"),
      docEvent(2, "block_delta"),
      docEvent(3, "block_delta"),
      chat(4, "m1", "text", "尾帧"),
    ];

    const out = aggregateFrameLogEntries(entries) as FrameLogExportEntry[];

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      frame: {
        kind: "docGenerationEvent@merged",
        data: {
          frames: 3,
          seqFirst: 1,
          seqLast: 3,
          kinds: { generation_started: 1, block_delta: 2 },
        },
      },
    });
  });

  it("测试构造序列可从 8 行聚合到 5 行", () => {
    const entries = [
      chat(1, "m1", "text", "a"),
      chat(2, "m1", "text", "b"),
      snapshot(3, "v1"),
      snapshot(4, "v2"),
      docEvent(5, "block_delta"),
      docEvent(6, "block_delta"),
      chat(7, "m1", "text", "c"),
      chat(8, "m1", "text", "d"),
    ];

    expect(aggregateFrameLogEntries(entries)).toHaveLength(5);
  });
});

function chat(seq: number, messageId: string, partKind: string, body: string): FrameLogExportEntry {
  return {
    seq,
    epoch: 11,
    generation: 7,
    frame: {
      kind: "chatMessageAppended",
      data: {
        messageId,
        seq,
        part: { kind: partKind, data: { body } },
      },
    } as FrameLogExportEntry["frame"],
  };
}

function snapshot(seq: number, text: string): FrameLogExportEntry {
  return {
    seq,
    epoch: 11,
    generation: 7,
    frame: {
      kind: "documentSnapshotWritten",
      data: { doc: { version: seq, ts: "2026-07-08T00:00:00.000Z", sections: [{ text }] } },
    } as FrameLogExportEntry["frame"],
  };
}

function docEvent(seq: number, kind: string): FrameLogExportEntry {
  return {
    seq,
    epoch: 11,
    generation: 7,
    frame: {
      kind: "docGenerationEvent",
      data: { kind },
    } as FrameLogExportEntry["frame"],
  };
}
