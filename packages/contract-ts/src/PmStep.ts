export type PmStep = {
  stepType: string;
  from?: number;
  to?: number;
  slice?: unknown;
  structure?: boolean;
  /** document_ops 审阅提交的幂等恢复元数据；ProseMirror 应用器会忽略未知字段。 */
  suggestionId?: string;
  /** 整批候选终稿整体替换时，一条真实 replace step 对应的全部审阅项。 */
  suggestionIds?: string[];
};
