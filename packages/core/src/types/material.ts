/** A parsed and stored material in the session's material library. */
export interface Material {
  id: string;
  filename: string;
  mimeType: string;
  text: string;
  summary: string | null;
  /** Server-assigned upload UUID, used for file serving via /api/v1/files/:fileId. */
  fileId: string | null;
  metadata: {
    pages: number | null;
    wordCount: number;
    title: string | null;
    /** 抓取类素材的来源 URL(parseFile 上传类为 null),供溯源与按源去重。 */
    sourceUrl?: string | null;
    /** 缺省按 ready 处理，失败素材由 parseError 给出原因。 */
    parseState?: "ready" | "error";
    /** 解析失败时的友好错误文案；正常素材可为空或缺省。 */
    parseError?: string | null;
  };
  createdAt: string;
  updatedAt: string;
}
