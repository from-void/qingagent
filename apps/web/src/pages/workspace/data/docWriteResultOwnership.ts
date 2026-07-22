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
