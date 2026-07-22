import type { BridgeFrame } from "@qingagent/contract-ts";

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
