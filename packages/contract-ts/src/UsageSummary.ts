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
  /** 主动中止等场景的本地估算，始终与 provider 实测字段分开。 */
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedCacheHitTokens?: number;
  estimatedCacheMissTokens?: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** 每个会话调用点首次请求用于建缓存的 miss token；旧服务端可能缺省。 */
  coldStartMissTokens?: number;
  cacheCreationTokens: number;
  cacheHitRate: number | null;
  calls: number;
  recordedCalls: number;
  estimatedCalls?: number;
  missingCalls: number;
  coverageRate: number;
  costCny?: number;
  estimatedCostCny?: number;
  /** 按北京时间高峰窗口计价的请求数及其实际倍率范围。 */
  peakPricedCalls?: number;
  peakPricingMultiplierMin?: number;
  peakPricingMultiplierMax?: number;
}

export interface UsageSummaryResponse {
  view: UsageSummaryView;
  rows: UsageSummaryRow[];
}
