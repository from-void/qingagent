/** writeDraft 聊天内迷你草稿卡的渲染数据。
 *  生成期间由 writedraft-progress 流式刷新(writing/revising/finalizing),
 *  工具结束时由 tool-result 定格(done/failed),含字数校验结果。 */
export type WriteDraftFailureDiagnostic = {
  /** 内部失败分类；不包含原始模型输出或正文。 */
  failureKind: string;
  /** 有害 warning 的稳定错误码，已去重并封顶。 */
  warningKinds: string[];
  /** 只含白名单标签名的有界 QingML 骨架；正文、属性值均已移除。 */
  tagSkeleton: string;
  /** 错误在原始输出中的数字偏移或 schema 路径；不保留附近原文。 */
  errorLocations: Array<{
    kind: string;
    startOffset?: number;
    endOffset?: number;
    path?: Array<string | number>;
  }>;
};

export type WriteDraftCardBody = {
  /** 文档标题(来自 writeDraft 入参)。 */
  title: string;
  /** writing=生成中;revising=字数修订中;finalizing=定稿中;done=完成;failed=生成失败。 */
  phase: "writing" | "revising" | "finalizing" | "done" | "failed";
  /** 已写正文可见字符数(流式期间为实时估计,结束后为最终值)。 */
  charCount: number;
  /** 生成流中为 true；完成卡的数字一律是引擎 canonical 终态值。 */
  charCountApproximate?: boolean;
  /** 正文滚动摘录(最近写出的一小段),done/failed 后为 null。 */
  excerpt: string | null;
  /** 仅 failed 进度帧可带的脱敏诊断；前端不展示为用户错误文案。 */
  diagnostic?: WriteDraftFailureDiagnostic | null;
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
