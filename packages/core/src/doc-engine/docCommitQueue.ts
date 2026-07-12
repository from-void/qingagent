/**
 * 文档提交队列只在单进程内有效,跨进程靠 CAS / snapshot high-water 兜底。
 *
 * commitDocumentOp 复用 documentsClient 的进程内单例连接；同一连接上重叠执行
 * BEGIN IMMEDIATE 会触发 "cannot start a transaction within a transaction"。
 * 因此这里必须是全局单链,不能按 docId 分桶。
 */
let commitTail: Promise<unknown> = Promise.resolve();

export function runExclusiveCommit<T>(fn: () => Promise<T>): Promise<T> {
  const result = commitTail.then(fn);
  commitTail = result.catch(() => undefined);
  return result;
}

export function __resetDocCommitQueueForTest(): void {
  commitTail = Promise.resolve();
}
