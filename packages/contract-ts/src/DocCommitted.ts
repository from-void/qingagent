export type DocCommitted = {
  sessionId: string;
  version: number;
  toolCallId?: string;
  /** 本次真实写入的局部修改数；旧帧可缺省。 */
  appliedCount?: number;
  /** 本次因锚点失效而未写入的局部修改数；旧帧可缺省。 */
  conflictCount?: number;
};
