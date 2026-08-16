import { describe, expect, it } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { getPmContentHash, type PmDoc } from "@qingagent/pm-schema";
import {
  acknowledgedDocWriteContentHash,
  appliedDocVersionFromBroadcastFrame,
  broadcastContentFrameWritesDocumentVersion,
  decideBroadcastDocumentFrame,
  shouldHandleBroadcastDocumentFrame,
  shouldHandleDocWriteResult,
  splitStreamEndFinalDocument,
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

  it("成功回执优先采用服务端 canonical hash，旧端缺字段才自算", () => {
    const submittedDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "materialized-trailing" },
      }],
    };
    expect(acknowledgedDocWriteContentHash(
      {
        ok: true,
        clientMutationId: "mutation-canonical",
        docVersion: 1,
        contentHash: "pmv1-canonical",
        createdNewVersion: false,
      },
      submittedDoc,
    )).toBe("pmv1-canonical");
    expect(acknowledgedDocWriteContentHash(
      { ok: true, clientMutationId: "mutation-legacy", docVersion: 1 },
      submittedDoc,
    )).toBe(getPmContentHash(submittedDoc));
  });
});

describe("decideBroadcastDocumentFrame", () => {
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

  const decide = (
    frame: BridgeFrame,
    dirty: Partial<Parameters<typeof decideBroadcastDocumentFrame>[0]> = {},
  ) => decideBroadcastDocumentFrame({
    frame,
    editorDirty: false,
    pendingDocWrite: false,
    queuedDocWrite: false,
    scheduledDocWrite: false,
    ...dirty,
  });

  it("dirty + generation_finished 先 defer，drain 后仍 dirty 则显式 conflict", () => {
    const frame = versionWritingFrames[2]!;
    expect(decide(frame, { editorDirty: true })).toEqual({
      kind: "defer",
      reason: "agent_final_waiting_for_editor_save",
    });
    expect(decide(frame, {
      editorDirty: true,
      afterDeferredDrain: true,
    })).toEqual({
      kind: "conflict",
      reason: "local_editor_changes",
    });
  });

  it.each([
    ["pendingDocWrite", { pendingDocWrite: true }, "pending_doc_write"],
    ["queuedDocWrite", { queuedDocWrite: true }, "queued_doc_write"],
    ["scheduledDocWrite", { scheduledDocWrite: true }, "scheduled_doc_write"],
  ] as const)("%s 在途时延迟终稿而非丢弃", (_name, dirty, reason) => {
    expect(decide(versionWritingFrames[2]!, dirty)).toEqual({
      kind: "defer",
      reason,
    });
  });

  it("外部快照撞上无在途保存的实质编辑时进入 conflict，不覆盖本地正文", () => {
    expect(decide(versionWritingFrames[0]!, { editorDirty: true })).toEqual({
      kind: "conflict",
      reason: "local_editor_changes",
    });
  });

  it("pendingReview 的审阅投影不能反过来拦掉权威 docDiffReady", () => {
    const diffFrame = versionWritingFrames.find((frame) => frame.kind === "docDiffReady");
    expect(diffFrame?.kind).toBe("docDiffReady");
    if (diffFrame?.kind !== "docDiffReady") throw new Error("missing docDiffReady fixture");

    expect(shouldHandleBroadcastDocumentFrame({
      frame: diffFrame,
      hasLocalDocumentChanges: true,
      reviewActive: true,
    })).toBe(true);
    expect(shouldHandleBroadcastDocumentFrame({
      frame: diffFrame,
      hasLocalDocumentChanges: true,
      reviewActive: false,
    })).toBe(false);
  });

  it("首个候选帧虽早于 pendingReview，只要 previewDoc 与无待办编辑器一致就直接应用", () => {
    const diffFrame = versionWritingFrames.find((frame) => frame.kind === "docDiffReady");
    expect(diffFrame?.kind).toBe("docDiffReady");
    if (diffFrame?.kind !== "docDiffReady") throw new Error("missing docDiffReady fixture");

    expect(decide(diffFrame, {
      editorDirty: true,
      reviewActive: false,
      incomingDocumentMatchesEditor: true,
    })).toEqual({ kind: "apply" });
    expect(decide(diffFrame, {
      editorDirty: true,
      reviewActive: false,
      incomingDocumentMatchesEditor: false,
    })).toEqual({
      kind: "conflict",
      reason: "local_editor_changes",
    });
  });

  it("pendingReview 后迟到的同基线 canonical 快照由正文相等证明吸收，真实版本分叉仍冲突", () => {
    const snapshot = versionWritingFrames[0]!;

    expect(decide(snapshot, {
      editorDirty: true,
      reviewActive: false,
      incomingDocumentMatchesEditor: true,
    })).toEqual({ kind: "apply" });
    expect(decide(snapshot, {
      editorDirty: true,
      reviewActive: true,
      reviewBaseVersion: 2,
      incomingDocumentMatchesEditor: true,
    })).toEqual({
      kind: "reconcile",
      reason: "equivalent_review_base",
    });
    expect(decide(snapshot, {
      editorDirty: false,
      reviewActive: true,
      reviewBaseVersion: 2,
      incomingDocumentMatchesEditor: true,
    })).toEqual({
      kind: "reconcile",
      reason: "equivalent_review_base",
    });
    expect(decide(snapshot, {
      editorDirty: true,
      reviewActive: true,
      reviewBaseVersion: 1,
      incomingDocumentMatchesEditor: true,
    })).toEqual({
      kind: "conflict",
      reason: "review_base_version_diverged",
    });
  });

  it("同版本审阅基线比较暂不可用时保留候选，不伪报正文分叉", () => {
    const snapshot = versionWritingFrames[0]!;
    expect(decide(snapshot, {
      editorDirty: true,
      reviewActive: true,
      reviewBaseVersion: 2,
      incomingDocumentComparisonUnavailable: true,
    })).toEqual({
      kind: "reconcile",
      reason: "unavailable_same_review_base",
    });
    expect(decide(snapshot, {
      editorDirty: true,
      reviewActive: true,
      reviewBaseVersion: 1,
      incomingDocumentComparisonUnavailable: true,
    })).toEqual({
      kind: "conflict",
      reason: "local_editor_changes",
    });
  });

  it.each([
    ["pendingDocWrite", { pendingDocWrite: true }, "pending_doc_write"],
    ["queuedDocWrite", { queuedDocWrite: true }, "queued_doc_write"],
    ["scheduledDocWrite", { scheduledDocWrite: true }, "scheduled_doc_write"],
  ] as const)("正文相等证明也不越过 %s", (_name, dirty, reason) => {
    const diffFrame = versionWritingFrames.find((frame) => frame.kind === "docDiffReady")!;
    expect(decide(diffFrame, {
      ...dirty,
      editorDirty: true,
      incomingDocumentMatchesEditor: true,
    })).toEqual({ kind: "defer", reason });
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

  it("stream end 终态收据可登记版本，并拆成生命周期与正文两条独立决策链", () => {
    const terminalFrame: BridgeFrame = {
      kind: "stream",
      data: {
        kind: "end",
        data: {
          streamId: "stream-1",
          reason: { kind: "done" },
          finalDocument: {
            version: 4,
            contentHash: "terminal-hash",
            doc: pmDoc,
          },
        },
      },
    };

    expect(appliedDocVersionFromBroadcastFrame(terminalFrame)).toEqual({
      version: 4,
      contentHash: "terminal-hash",
      pmDoc,
    });
    expect(splitStreamEndFinalDocument(terminalFrame)).toEqual({
      lifecycleFrame: {
        kind: "stream",
        data: {
          kind: "end",
          data: {
            streamId: "stream-1",
            reason: { kind: "done" },
          },
        },
      },
      documentFrame: {
        kind: "docGenerationEvent",
        data: {
          kind: "generation_finished",
          data: {
            generationId: "terminal-stream-1",
            seq: 1,
            prevSeq: null,
            doc: pmDoc,
            finalVersion: 4,
            contentHash: "terminal-hash",
          },
        },
      },
    });
  });

  it("干净标签照常消费版本帧，非终态帧不受 dirty 守卫影响", () => {
    for (const frame of versionWritingFrames) {
      expect(decide(frame)).toEqual({ kind: "apply" });
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
      expect(decide(frame, { editorDirty: true })).toEqual({ kind: "apply" });
    }
  });
});
