export type DocCommitted = {
  sessionId: string;
  version: number;
  toolCallId?: string;
  /** 本次真实写入的局部修改数。 */
  appliedCount: number;
  /** 本次因锚点失效而未写入的局部修改数。 */
  conflictCount: number;
  /** 成功写入但发生非阻断有损降级时的短告知；前端用全局 warn toast 展示。 */
  notice?: string;
};
