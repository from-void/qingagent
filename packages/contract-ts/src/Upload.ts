export const MATERIAL_UPLOAD_ERROR_CODES = [
  "material_format_mismatch",
  "material_unreadable",
  "material_unsupported",
] as const;

export type MaterialUploadErrorCode = (typeof MATERIAL_UPLOAD_ERROR_CODES)[number];

export type UploadPurpose = "material";

export interface UploadRequest {
  filename: string;
  mimeType?: string;
  content: string;
  purpose?: UploadPurpose;
}
