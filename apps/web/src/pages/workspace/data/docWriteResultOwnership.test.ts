import { describe, expect, it } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import {
  appliedDocVersionFromBroadcastFrame,
  broadcastContentFrameWritesDocumentVersion,
  shouldHandleBroadcastDocumentFrame,
  shouldHandleDocWriteResult,
} from "./docWriteResultOwnership";

const pmDoc = {
  type: "doc" as const,
  attrs: { schemaVersion: 1 as const },
  content: [],
};

describe("shouldHandleDocWriteResult", () => {
  it("忽略外标签广播的成功/冲突回执，不推进本标签旧正文的版本基线", () => {
    expect(shouldHandleDocWriteResult({
      isLatestOwnMutation: false,
      hasMatchingWaiter: false,
    })).toBe(false);
  });

  it("本标签匹配 latest mutation 或 waiter 时消费回执", () => {
    expect(shouldHandleDocWriteResult({
      isLatestOwnMutation: true,
      hasMatchingWaiter: false,
    })).toBe(true);
    expect(shouldHandleDocWriteResult({
      isLatestOwnMutation: false,
      hasMatchingWaiter: true,
    })).toBe(true);
  });
});

describe("shouldHandleBroadcastDocumentFrame", () => {
  const versionWritingFrames: BridgeFrame[] = [
    {
      kind: "documentSnapshotWritten",
      data: { doc: { version: 2, ts: "t", doc: pmDoc } },
    },
    {
      kind: "docDiffReady",
      data: { baseVersion: 2, suggestions: [], previewDoc: pmDoc },
    },
    {
      kind: "docGenerationEvent",
      data: {
        kind: "generation_finished",
        data: {
          generationId: "g-1",
          seq: 2,
          prevSeq: 1,
          doc: pmDoc,
          finalVersion: 2,
          contentHash: "hash",
        },
      },
    },
  ];

  it("dirty 时冻结全部广播版本写入路径", () => {
    for (const frame of versionWritingFrames) {
      expect(broadcastContentFrameWritesDocumentVersion(frame)).toBe(true);
      expect(shouldHandleBroadcastDocumentFrame({
        frame,
        hasLocalDocumentChanges: true,
      })).toBe(false);
    }
  });

  it("会写版本的帧都能取出该版本与正文,供登记为本会话已知产出", () => {
    // agent 生成流产出的版本必须进已知产出集,否则它推进版本后本标签的旧基线写
    // 会被当成"外部并发"误弹重载横幅(战役缺陷#2)。
    expect(appliedDocVersionFromBroadcastFrame(versionWritingFrames[0]!)).toEqual({
      version: 2,
      pmDoc,
    });
    expect(appliedDocVersionFromBroadcastFrame(versionWritingFrames[1]!)).toEqual({
      version: 2,
      pmDoc,
    });
    expect(appliedDocVersionFromBroadcastFrame(versionWritingFrames[2]!)).toEqual({
      version: 2,
      pmDoc,
      contentHash: "hash",
    });
    expect(appliedDocVersionFromBroadcastFrame({
      kind: "docWriteResult",
      data: { ok: true, clientMutationId: "m", docVersion: 3 },
    })).toBeNull();
  });

  it("干净标签照常消费版本帧，非终态帧不受 dirty 守卫影响", () => {
    for (const frame of versionWritingFrames) {
      expect(shouldHandleBroadcastDocumentFrame({
        frame,
        hasLocalDocumentChanges: false,
      })).toBe(true);
    }

    const nonVersionFrames: BridgeFrame[] = [
      {
        kind: "docDiffReady",
        data: { baseVersion: 2, suggestions: [] },
      },
      {
        kind: "docGenerationEvent",
        data: {
          kind: "generation_started",
          data: {
            generationId: "g-1",
            seq: 1,
            prevSeq: null,
            sessionId: "s-1",
            baseVersion: 1,
          },
        },
      },
    ];
    for (const frame of nonVersionFrames) {
      expect(broadcastContentFrameWritesDocumentVersion(frame)).toBe(false);
      expect(shouldHandleBroadcastDocumentFrame({
        frame,
        hasLocalDocumentChanges: true,
      })).toBe(true);
    }
  });
});
