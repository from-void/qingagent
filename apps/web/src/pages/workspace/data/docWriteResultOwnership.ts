import type { BridgeFrame } from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/pm-schema";

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
    default:
      return null;
  }
}

/**
 * 外标签广播若在本标签仍有未落盘编辑时推进版本/正文，会制造“新版本号 + 旧正文”。
 * dirty 期间保留旧基线，令下一次 updateDoc 由服务端乐观锁明确报 conflict。
 */
export function shouldHandleBroadcastDocumentFrame(input: {
  frame: BridgeFrame;
  hasLocalDocumentChanges: boolean;
}): boolean {
  return !(
    input.hasLocalDocumentChanges &&
    broadcastContentFrameWritesDocumentVersion(input.frame)
  );
}
