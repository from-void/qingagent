export const MATERIAL_UPLOAD_ERROR_CODES = [
  "material_format_mismatch",
  "material_unreadable",
  "material_unsupported",
] as const;

export type MaterialUploadErrorCode = (typeof MATERIAL_UPLOAD_ERROR_CODES)[number];

export type UploadPurpose = "material";

/** 原始二进制上传请求头；文件名使用 encodeURIComponent 编码。 */
export const UPLOAD_FILENAME_HEADER = "X-QingAgent-Filename";
export const UPLOAD_PURPOSE_HEADER = "X-QingAgent-Upload-Purpose";
export const UPLOAD_SESSION_HEADER = "X-QingAgent-Session-Id";
