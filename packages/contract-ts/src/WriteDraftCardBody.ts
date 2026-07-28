/** writeDraft 聊天内迷你草稿卡的渲染数据。
 *  生成期间由 writedraft-progress 流式刷新(writing/revising/finalizing),
 *  工具结束时由 tool-result 定格(done/failed),含字数校验结果。 */
export type WriteDraftCardBody = {
  /** 文档标题(来自 writeDraft 入参)。 */
  title: string;
  /** writing=生成中;revising=字数修订中;finalizing=定稿中;done=完成;failed=生成失败。 */
  phase: "writing" | "revising" | "finalizing" | "done" | "failed";
  /** 已写正文可见字符数(流式期间为实时估计,结束后为最终值)。 */
  charCount: number;
  /** 正文滚动摘录(最近写出的一小段),done/failed 后为 null。 */
  excerpt: string | null;
  /** 展示 lane 切换或 winner 全文帧；前端须直接替换摘录缓冲，不能按字符重叠续接。 */
  resetExcerpt?: boolean;
  /** 长度规格(用户没给字数时全为 null)。 */
  targetLength: number | null;
  minLength: number | null;
  maxLength: number | null;
  /** 自动修订轮数。 */
  revisionCount: number;
  /** 字数验收状态(writeDraft 出参的 lengthStatus,流式期间为 null)。 */
  lengthStatus: string | null;
};
