import type { BridgeFrame } from "@qingagent/contract-ts";
import { getPmContentHash, type PmDoc } from "@qingagent/pm-schema";

type DocWriteResultData = Extract<BridgeFrame, { kind: "docWriteResult" }>["data"];
type DocWriteSuccessData = Extract<DocWriteResultData, { ok: true }>;

/** 新服务端回权威 canonical hash；旧服务端缺字段时保持本地自算兼容。 */
export function acknowledgedDocWriteContentHash(
  result: DocWriteSuccessData,
  submittedDoc: PmDoc,
): string {
  return result.contentHash ?? getPmContentHash(submittedDoc);
}

/**
 * docWriteResult 是某次 clientMutationId 的私有回执，却会经会话 FrameLog 广播给
 * 所有标签。只有持有该 mutation 的标签可以消费；否则外标签会只推进版本号而不
 * 同步正文，下一次整篇保存就可能用“新版本号 + 旧正文”静默覆盖他人改动。
 */
export function shouldHandleDocWriteResult(input: {
  isLatestOwnMutation: boolean;
  hasMatchingWaiter: boolean;
}): boolean {
  return input.isLatestOwnMutation || input.hasMatchingWaiter;
}

/**
 * 审计 workspaceReducer 中所有会从广播内容帧写入 draft.version 的路径。
 * docWriteResult 由上面的 mutation ownership 单独守卫；会话重置与本地事务不在此列。
 */
export function broadcastContentFrameWritesDocumentVersion(
  frame: BridgeFrame,
): boolean {
  switch (frame.kind) {
    case "documentSnapshotWritten":
      return true;
    case "docDiffReady":
      return frame.data.previewDoc !== undefined;
    case "docGenerationEvent":
      return frame.data.kind === "generation_finished";
    case "stream":
      return (
        frame.data.kind === "end" &&
        frame.data.data.finalDocument !== undefined
      );
    default:
      return false;
  }
}

/**
 * 这一帧应用下来的是哪一版文档(版本号 + 该版本的正文)。
 * 与 broadcastContentFrameWritesDocumentVersion 同一张表:凡是会写 draft.version 的帧,
 * 应用时都把该版本登记进"本会话已知产出"账本——尤其是 agent 生成流产出的版本,
 * 它绝不是外部并发,后续冲突要静默改基线重放而不是弹重载横幅。
 */
export interface AppliedDocVersion {
  version: number;
  pmDoc: PmDoc;
  /** 服务端算好的 canonical contentHash(有则优先) */
  contentHash?: string;
}

export function appliedDocVersionFromBroadcastFrame(
  frame: BridgeFrame,
): AppliedDocVersion | null {
  switch (frame.kind) {
    case "documentSnapshotWritten":
      return frame.data.doc.doc
        ? { version: frame.data.doc.version, pmDoc: frame.data.doc.doc as PmDoc }
        : null;
    case "docGenerationEvent":
      return frame.data.kind === "generation_finished"
        ? {
            version: frame.data.data.finalVersion,
            pmDoc: frame.data.data.doc as PmDoc,
            contentHash: frame.data.data.contentHash,
          }
        : null;
    case "docDiffReady":
      // previewDoc = 候选生成时刻的真实旧文档,它对应 baseVersion 那一版
      return frame.data.previewDoc !== undefined
        ? {
            version: frame.data.baseVersion,
            pmDoc: frame.data.previewDoc as PmDoc,
          }
        : null;
    case "stream":
      return frame.data.kind === "end" && frame.data.data.finalDocument
        ? {
            version: frame.data.data.finalDocument.version,
            pmDoc: frame.data.data.finalDocument.doc as PmDoc,
            contentHash: frame.data.data.finalDocument.contentHash,
          }
        : null;
    default:
      return null;
  }
}

/**
 * 外标签广播若在本标签仍有未落盘编辑时推进版本/正文，会制造“新版本号 + 旧正文”。
 * dirty 期间保留旧基线，令下一次 updateDoc 由服务端乐观锁明确报 conflict。
 */
export type DocumentFrameDecision =
  | { kind: "apply" }
  | {
      kind: "reconcile";
      reason: "equivalent_review_base" | "unavailable_same_review_base";
    }
  | {
      kind: "defer";
      reason:
        | "pending_doc_write"
        | "queued_doc_write"
        | "scheduled_doc_write"
        | "agent_final_waiting_for_editor_save";
    }
  | {
      kind: "conflict";
      reason: "local_editor_changes" | "review_base_version_diverged";
    };

function isAgentFinalDocumentFrame(frame: BridgeFrame): boolean {
  return (
    (
      frame.kind === "docGenerationEvent" &&
      frame.data.kind === "generation_finished"
    ) ||
    (
      frame.kind === "stream" &&
      frame.data.kind === "end" &&
      frame.data.data.finalDocument !== undefined
    )
  );
}

export function shouldHandleBroadcastDocumentFrame(input: {
  frame: BridgeFrame;
  hasLocalDocumentChanges: boolean;
  /** pendingReview 里的正文差异来自审阅投影，不是用户尚未落盘的编辑。 */
  reviewActive?: boolean;
}): boolean {
  if (input.frame.kind === "docDiffReady" && input.reviewActive === true) {
    return true;
  }
  return !(
    input.hasLocalDocumentChanges &&
    broadcastContentFrameWritesDocumentVersion(input.frame)
  );
}

/**
 * stream end 的生命周期终态必须先消费；正文回执再单独走 dirty 决策。
 * 转成 generation_finished 后可复用 presentation/reducer/版本账本链。
 */
export function splitStreamEndFinalDocument(frame: BridgeFrame): {
  lifecycleFrame: BridgeFrame;
  documentFrame: BridgeFrame;
} | null {
  if (
    frame.kind !== "stream" ||
    frame.data.kind !== "end" ||
    !frame.data.data.finalDocument
  ) {
    return null;
  }
  const { streamId, reason, finalDocument } = frame.data.data;
  return {
    lifecycleFrame: {
      kind: "stream",
      data: { kind: "end", data: { streamId, reason } },
    },
    documentFrame: {
      kind: "docGenerationEvent",
      data: {
        kind: "generation_finished",
        data: {
          generationId: `terminal-${streamId}`,
          seq: 1,
          prevSeq: null,
          doc: finalDocument.doc,
          finalVersion: finalDocument.version,
          contentHash: finalDocument.contentHash,
        },
      },
    },
  };
}

/**
 * 广播正文帧必须得到显式去向，禁止用 boolean 守卫把终稿静默遗忘。
 *
 * - 本地保存链仍在 drain：先延迟，待私有回执推进基线后重判。
 * - Agent 终稿撞上编辑器 debounce：先 flush/defer；flush 后若仍 dirty，
 *   控制器会再次调用本函数并进入 conflict。
 * - 只有没有在途保存可解释的真实编辑器差异才是冲突。
 */
export function decideBroadcastDocumentFrame(input: {
  frame: BridgeFrame;
  editorDirty: boolean;
  pendingDocWrite: boolean;
  queuedDocWrite: boolean;
  scheduledDocWrite: boolean;
  /** 编辑器已无待保存事务且正文与帧携带的规范化 PM 完全相等。 */
  incomingDocumentMatchesEditor?: boolean;
  /** 当前编辑器或 PM schema 无法完成语义比较。 */
  incomingDocumentComparisonUnavailable?: boolean;
  /** pendingReview 里的正文差异来自审阅投影，不是用户尚未落盘的编辑。 */
  reviewActive?: boolean;
  /** 当前审阅候选所基于的 canonical 版本。 */
  reviewBaseVersion?: number | null;
  /** 保存 drain 后的二次判定，不再把持续 editor dirty 当成 debounce。 */
  afterDeferredDrain?: boolean;
}): DocumentFrameDecision {
  if (!broadcastContentFrameWritesDocumentVersion(input.frame)) {
    return { kind: "apply" };
  }
  if (input.pendingDocWrite) {
    return { kind: "defer", reason: "pending_doc_write" };
  }
  if (input.queuedDocWrite) {
    return { kind: "defer", reason: "queued_doc_write" };
  }
  if (input.scheduledDocWrite) {
    return { kind: "defer", reason: "scheduled_doc_write" };
  }
  if (
    input.frame.kind === "docDiffReady" &&
    input.reviewActive === true
  ) {
    return { kind: "apply" };
  }
  // pendingReview 的同基线 canonical 必须优先于粗粒度 editorDirty 判定：
  // dirty 兜底与语义比较统一后，schema 默认 attrs / blockId 漂移会正确返回干净，
  // 但这帧仍只能 reconcile，不能按普通干净快照 apply 后清掉现有候选。
  if (
    input.incomingDocumentMatchesEditor === true &&
    input.reviewActive === true
  ) {
    const incoming = appliedDocVersionFromBroadcastFrame(input.frame);
    if (
      incoming !== null &&
      input.reviewBaseVersion === incoming.version
    ) {
      return { kind: "reconcile", reason: "equivalent_review_base" };
    }
    return { kind: "conflict", reason: "review_base_version_diverged" };
  }
  if (!input.editorDirty) return { kind: "apply" };
  if (
    input.incomingDocumentComparisonUnavailable === true &&
    input.reviewActive === true
  ) {
    const incoming = appliedDocVersionFromBroadcastFrame(input.frame);
    if (
      incoming !== null &&
      input.reviewBaseVersion === incoming.version
    ) {
      // 同版本 canonical 只需保留当前候选，不会覆盖 live 正文。比较器异常时
      // 把这一帧静默留在原基线上，比伪造“正文已分叉”冲突更准确也更安全。
      return { kind: "reconcile", reason: "unavailable_same_review_base" };
    }
  }
  if (input.incomingDocumentMatchesEditor === true) {
    return { kind: "apply" };
  }
  if (isAgentFinalDocumentFrame(input.frame) && !input.afterDeferredDrain) {
    return {
      kind: "defer",
      reason: "agent_final_waiting_for_editor_save",
    };
  }
  return { kind: "conflict", reason: "local_editor_changes" };
}
