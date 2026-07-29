import { createHash } from "node:crypto";
import { extname } from "node:path";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object"
    ? value as UnknownRecord
    : null;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeFilenameExtension(input: UnknownRecord): string | null {
  const candidate = hasNonEmptyString(input.filename)
    ? input.filename
    : hasNonEmptyString(input.filePath)
      ? input.filePath
      : "";
  const extension = extname(candidate).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function summarizeParseFileInput(input: unknown): Record<string, unknown> {
  const record = asRecord(input) ?? {};
  const fileId = hasNonEmptyString(record.fileId) ? record.fileId : null;
  const hasFileId = fileId !== null;
  const hasFilePath = hasNonEmptyString(record.filePath);
  const hasContent = hasNonEmptyString(record.content);
  return {
    inputMode: hasFileId
      ? "fileId"
      : hasFilePath
        ? "filePath"
        : hasContent
          ? "content"
          : "missing",
    hasFileId,
    hasFilePath,
    hasContent,
    fileIdHash: fileId === null
      ? null
      : createHash("sha256").update(fileId).digest("hex").slice(0, 12),
    filenameExtension: safeFilenameExtension(record),
  };
}

export function summarizeParseFileOutput(
  output: unknown,
  options: { extractionCached?: boolean } = {},
): Record<string, unknown> {
  const record = asRecord(output) ?? {};
  const metadata = asRecord(record.metadata) ?? {};
  const text = typeof record.text === "string" ? record.text : "";
  return {
    ok: typeof record.ok === "boolean"
      ? record.ok
      : !hasNonEmptyString(record.error) && !hasNonEmptyString(record.failureKind),
    failureKind: hasNonEmptyString(record.failureKind) ? record.failureKind : null,
    errorCode: hasNonEmptyString(record.errorCode) ? record.errorCode : null,
    textLength: text.length,
    wordCount: finiteNumber(metadata.wordCount) ?? finiteNumber(record.wordCount),
    pages: finiteNumber(metadata.pages) ?? finiteNumber(record.pages),
    ...(options.extractionCached === undefined
      ? {}
      : { extractionCached: options.extractionCached }),
  };
}
