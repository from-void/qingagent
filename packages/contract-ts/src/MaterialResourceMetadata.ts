/** 素材解析后的落库状态；解析中只存在于前端本地态，不进入契约。 */
export type ParseState = "ready" | "error";

/** Material 类型资源塞在 Resource.metadata 内的显式结构。 */
export interface MaterialResourceMetadata {
  /** 服务端上传文件 UUID，上传类素材用于预览与重试解析。 */
  fileId?: string | null;
  /** 抓取类素材来源 URL；上传类通常为 null。 */
  sourceUrl?: string | null;
  /** 素材最近一次写入时间,作为前端解析态 reconcile 的版本号。 */
  updatedAt?: string | null;
  pages: number | null;
  wordCount: number;
  title: string | null;
  /** 缺省按 ready 处理，兼容旧会话数据。 */
  parseState?: ParseState;
  /** parseState 为 error 时的友好错误文案。 */
  parseError?: string | null;
}
