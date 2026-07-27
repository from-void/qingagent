import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { collectFrameLogs } from "../diagnostics/collect";

const mocks = vi.hoisted(() => {
  const frameLog = {
    readFrom: vi.fn(),
  };
  return {
    sessionManager: {
      frameLog,
      listSessionIds: vi.fn(),
    },
    collectRestoreFrames: vi.fn(),
  };
});

vi.mock("../gateway/bridgeHandler.js", () => mocks);

function emptyRead() {
  return {
    frames: [],
    minSeq: 1,
    nextSeq: 1,
    epoch: 10,
    gap: false,
    activeRunner: false,
  };
}

const restoredFrames = [
  {
    kind: "documentSnapshotWritten",
    data: {
      doc: {
        version: 1,
        ts: "2026-07-07T00:00:00.000Z",
        sections: [{ kind: "p", data: { text: "正文内容：冷恢复文章正文" } }],
      },
    },
  },
  {
    kind: "chatMessageAdded",
    data: {
      message: {
        id: "u1",
        role: { kind: "user" },
        ts: "2026-07-07T00:00:01.000Z",
        parts: [{ kind: "text", data: { body: "用户问题：请修改文章" } }],
        chips: null,
      },
      appendSeq: 0,
    },
  },
  {
    kind: "chatMessageAdded",
    data: {
      message: {
        id: "a1",
        role: { kind: "agent" },
        ts: "2026-07-07T00:00:02.000Z",
        parts: [{ kind: "text", data: { body: "助手回答：已经完成修改" } }],
        chips: null,
      },
      appendSeq: 0,
    },
  },
] as unknown as BridgeFrame[];

describe("diagnostics collectFrameLogs", () => {
  beforeEach(() => {
    mocks.sessionManager.frameLog.readFrom.mockReturnValue(emptyRead());
    mocks.sessionManager.listSessionIds.mockReturnValue(["s-cold"]);
    mocks.collectRestoreFrames.mockResolvedValue(restoredFrames);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("L2 在内存 frameLog 为空时用恢复帧导出选中会话正文与对话", async () => {
    const files = await collectFrameLogs("L2", { sessionIds: ["s-cold"] });

    expect(mocks.sessionManager.frameLog.readFrom).toHaveBeenCalledWith("s-cold", 0);
    expect(mocks.collectRestoreFrames).toHaveBeenCalledWith("s-cold");
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("framelog/s-cold.jsonl");
    expect(files[0]?.frameCount).toBe(restoredFrames.length);
    expect(files[0]?.content).toContain("正文内容：冷恢复文章正文");
    expect(files[0]?.content).toContain("用户问题：请修改文章");
    expect(files[0]?.content).toContain("助手回答：已经完成修改");
  });

  it("L1 同一路恢复帧兜底仍不暴露正文与对话原文", async () => {
    const files = await collectFrameLogs("L1", { sessionIds: ["s-cold"] });

    expect(files).toHaveLength(1);
    expect(files[0]?.content).not.toContain("正文内容：冷恢复文章正文");
    expect(files[0]?.content).not.toContain("用户问题：请修改文章");
    expect(files[0]?.content).not.toContain("助手回答：已经完成修改");
    expect(files[0]?.content).toContain("[redacted:len=");
  });

  it("L1 按帧结构脱敏正文载体并摘要化未知 data/output", async () => {
    const secrets = [
      "衍生文档完整正文",
      "审阅补充要求原文",
      "建议摘要原文",
      "被删除的正文",
      "插入的新正文",
      "工具输出尾部原文",
      "未知 data 载荷原文",
      "未知 output 载荷原文",
    ];
    mocks.sessionManager.frameLog.readFrom.mockReturnValue({
      ...emptyRead(),
      frames: [
        frameEntry(1, {
          kind: "derivativeDocLoaded",
          data: {
            requestId: "request-1",
            meta: { privatePrompt: "私有提示词原文" },
            docPm: secrets[0],
            docVersion: 1,
            title: "衍生稿标题",
          },
        }),
        frameEntry(2, {
          kind: "reviewSupplementLoaded",
          data: { requestId: "request-2", type: "custom", supplement: secrets[1] },
        }),
        frameEntry(3, {
          kind: "docDiffReady",
          data: {
            baseVersion: 1,
            suggestions: [{
              id: "suggestion-1",
              summary: secrets[2],
              preview: { deleteText: secrets[3], insertText: secrets[4] },
            }],
          },
        }),
        frameEntry(4, {
          kind: "toolCallUpdated",
          data: {
            messageId: "message-1",
            toolCallId: "tool-1",
            spec: {
              id: "tool-1",
              name: "runCommand",
              result: { outputTail: secrets[5] },
            },
          },
        }),
        {
          ...frameEntry(5, {
            kind: "futureFrame",
            data: { arbitrary: secrets[6] },
          }),
          output: secrets[7],
        },
      ],
    });
    mocks.collectRestoreFrames.mockResolvedValue([]);

    const files = await collectFrameLogs("L1", { sessionIds: ["s-dirty"] });

    expect(files).toHaveLength(1);
    for (const secret of secrets) {
      expect(files[0]?.content).not.toContain(secret);
    }
    expect(files[0]?.content).not.toContain("私有提示词原文");
    expect(files[0]?.content).not.toContain("衍生稿标题");
    expect(files[0]?.content).toContain("[redacted:len=");
    expect(files[0]?.content).toContain('"omitted":true');
    expect(files[0]?.content).not.toContain('"output"');
  });

  it("导出前聚合 FrameLog,但 frameCount 保留原始帧数", async () => {
    mocks.sessionManager.frameLog.readFrom.mockReturnValue({
      ...emptyRead(),
      frames: [
        appended(1, "a1", "甲"),
        appended(2, "a1", "乙"),
        appended(3, "a1", "丙"),
      ],
    });
    mocks.collectRestoreFrames.mockResolvedValue([]);

    const files = await collectFrameLogs("L2", { sessionIds: ["s-hot"] });

    expect(files).toHaveLength(1);
    expect(files[0]?.frameCount).toBe(3);
    const lines = files[0]!.content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      frame: {
        kind: "chatMessageAppended@merged",
        data: {
          messageId: "a1",
          frames: 3,
          seqFirst: 1,
          seqLast: 3,
          chars: 3,
        },
      },
    });
  });
});

function appended(seq: number, messageId: string, body: string) {
  return {
    seq,
    epoch: 20,
    generation: 1,
    frame: {
      kind: "chatMessageAppended",
      data: {
        messageId,
        seq,
        part: { kind: "text", data: { body } },
      },
    },
  };
}

function frameEntry(seq: number, frame: unknown) {
  return {
    seq,
    epoch: 20,
    generation: 1,
    frame,
  };
}
