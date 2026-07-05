export const ACCEPTED_DOCUMENT_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".csv",
  ".ppt",
  ".pptx",
  ".txt",
  ".md",
  ".markdown",
] as const;

export const ACCEPTED_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
] as const;

export const ACCEPTED_DOCUMENT_ACCEPT_ATTR = [
  ...ACCEPTED_DOCUMENT_EXTENSIONS,
  ...ACCEPTED_DOCUMENT_MIME_TYPES,
].join(",");

export const ACCEPTED_DOCUMENT_LABEL = "PDF、Word、Excel、PPT、TXT、Markdown 文件";

// 图片(用于图像识别 readImage):后端 readImage 副基模支持 png/jpeg/webp/gif。
export const ACCEPTED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;
export const ACCEPTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

// 对话上传统一白名单 = 文档 + 图片(文档走 parseFile,图片走 readImage,由后端按 mime 分派)。
export const ACCEPTED_UPLOAD_EXTENSIONS = [
  ...ACCEPTED_DOCUMENT_EXTENSIONS,
  ...ACCEPTED_IMAGE_EXTENSIONS,
] as const;
export const ACCEPTED_UPLOAD_ACCEPT_ATTR = [
  ...ACCEPTED_UPLOAD_EXTENSIONS,
  ...ACCEPTED_DOCUMENT_MIME_TYPES,
  ...ACCEPTED_IMAGE_MIME_TYPES,
].join(",");
export const ACCEPTED_UPLOAD_LABEL = "PDF、Word、TXT、Markdown，或 PNG/JPG/WebP/GIF 图片";

export function isAcceptedUploadFile(file: Pick<File, "name" | "type">): boolean {
  const ext = acceptedDocumentExtension(file.name);
  return (
    ACCEPTED_UPLOAD_EXTENSIONS.includes(ext as (typeof ACCEPTED_UPLOAD_EXTENSIONS)[number]) ||
    ACCEPTED_DOCUMENT_MIME_TYPES.includes(file.type as (typeof ACCEPTED_DOCUMENT_MIME_TYPES)[number]) ||
    ACCEPTED_IMAGE_MIME_TYPES.includes(file.type as (typeof ACCEPTED_IMAGE_MIME_TYPES)[number])
  );
}

export function acceptedDocumentExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

export function isAcceptedDocumentFile(file: Pick<File, "name" | "type">): boolean {
  const ext = acceptedDocumentExtension(file.name);
  return (
    ACCEPTED_DOCUMENT_EXTENSIONS.includes(ext as (typeof ACCEPTED_DOCUMENT_EXTENSIONS)[number]) ||
    ACCEPTED_DOCUMENT_MIME_TYPES.includes(file.type as (typeof ACCEPTED_DOCUMENT_MIME_TYPES)[number])
  );
}
