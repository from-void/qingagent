import type {
  MaterialResourceMetadata,
  Resource,
} from "@qingagent/contract-ts";

export type SourceTag = "yuque" | "pdf" | "png" | "feishu";

export interface AssetSource {
  id: string;
  tag: SourceTag;
  name: string;
  meta: string;
  abstract: string;
  /** Plain-text body shown in the right-side preview panel. */
  bodyText: string;
  /** 素材正文版本；同一 id 更新时用于触发已打开预览重新拉取。 */
  updatedAt?: string;
  /** Server-assigned file ID for uploaded files (used for preview URL). */
  fileId?: string;
  /** MIME type of the uploaded file. */
  mimeType?: string;
  /** 抓取类素材的来源 URL(上传类无),预览面板展示可点击原链接。 */
  sourceUrl?: string;
  /** 内部预览内容来源。上传素材缺省走 fileId；连接文件夹文件走只读 /file 端点。 */
  preview?: {
    kind: "url";
    url: string;
    textUrl?: string;
    strictTextContentType?: boolean;
  };
}

/** Derive a display tag from the resource's mime type or displayName extension. */
function deriveTag(resource: Resource): SourceTag {
  const mime = resource.mime ?? "";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "png";

  // Fallback: derive from file extension
  const ext = resource.displayName.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp") return "png";
  if (ext === "md") return "yuque";
  if (ext === "doc" || ext === "docx") return "feishu";
  if (ext === "txt" || ext === "csv") return "yuque";

  return "yuque";
}

/** 把 mime/扩展名映射成中文友好类型标签(抓取的网页显示"网页",而非 text/html)。 */
function friendlyTypeLabel(resource: Resource): string {
  const mime = resource.mime ?? "";
  const name = resource.displayName.toLowerCase();
  if (mime.includes("html") || name.startsWith("http")) return "网页";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "PDF";
  if (mime.startsWith("image/")) return "图片";
  if (mime.includes("word") || name.endsWith(".doc") || name.endsWith(".docx")) return "Word";
  if (mime.startsWith("text/")) return "文本";
  return mime || "素材";
}

/** Convert a Resource to the AssetSource shape used by the material UI. */
export function toAssetSource(resource: Resource): AssetSource {
  const byteLabel = resource.byteLen != null ? `${resource.byteLen} 字` : "";
  const metaLine = [friendlyTypeLabel(resource), byteLabel].filter(Boolean).join(" · ");

  // Extract fileId / sourceUrl from metadata if present (set by server-side storeMaterial handler)
  const metadata = resource.metadata as MaterialResourceMetadata | null;
  const fileId = metadata?.fileId ?? undefined;
  const sourceUrl = metadata?.sourceUrl ?? undefined;
  const updatedAt = metadata?.updatedAt ?? undefined;

  return {
    id: resource.resourceRef.id,
    tag: deriveTag(resource),
    name: resource.displayName,
    meta: metaLine,
    abstract: resource.summary || "",
    // Material Resource 只携带摘要，不携带全文；正文必须走 scoped text API。
    bodyText: "",
    updatedAt,
    fileId,
    mimeType: resource.mime ?? undefined,
    sourceUrl,
  };
}

/** 用素材注册表的权威快照同步普通预览；连接文件夹的临时 URL 预览不受影响。 */
export function reconcileAssetPreview(
  preview: AssetSource | null,
  fileResources: readonly Resource[],
): AssetSource | null {
  if (!preview || preview.preview) return preview;
  const current = fileResources.find(
    (resource) => resource.resourceRef.id === preview.id,
  );
  if (!current) return null;
  const authoritative = toAssetSource(current);
  return (
    authoritative.abstract === preview.abstract &&
    authoritative.fileId === preview.fileId &&
    authoritative.sourceUrl === preview.sourceUrl &&
    authoritative.updatedAt === preview.updatedAt
  )
    ? preview
    : authoritative;
}
