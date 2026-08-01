export type UsageSummaryView = "day" | "session" | "total";

export interface UsageSummaryRow {
  bucket: string;
  /** 会话视图的文档标题。 */
  label?: string;
  /** 按天视图新增；旧服务端或无文档主表记录时可能缺失。 */
  documentId?: string;
  /** 按天视图新增；未命名文档可能缺失。 */
  documentTitle?: string;
  callSite: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** 每个会话调用点首次请求用于建缓存的 miss token；旧服务端可能缺省。 */
  coldStartMissTokens?: number;
  cacheCreationTokens: number;
  cacheHitRate: number | null;
  calls: number;
  recordedCalls: number;
  missingCalls: number;
  coverageRate: number;
  costCny?: number;
}

export interface UsageSummaryResponse {
  view: UsageSummaryView;
  rows: UsageSummaryRow[];
}
