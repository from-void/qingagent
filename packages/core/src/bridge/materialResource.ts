import type { BridgeFrame, Resource } from "@qingagent/contract-ts";
import crypto from "node:crypto";
import type { Material } from "../types/material.js";
import type { ParseFileBufferOutput } from "../tools/parseFile.js";
import type { SessionState } from "./sessionState.js";

export type MaterialParseFailureKind = "unsupported" | "error";

export type MaterialParseFailure = {
  kind: MaterialParseFailureKind;
  message: string;
  parseError?: string;
};

export type MaterialParseSource = {
  fileId: string;
  filename?: string | null;
  mimeType?: string | null;
};

export type MaterialParseOutcome = ParseFileBufferOutput | MaterialParseFailure;

export type UpsertMaterialByFileIdResult = {
  material: Material;
  frame: BridgeFrame;
};

function parseFileFailurePrefixKind(text: string): MaterialParseFailureKind | null {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[Unsupported]")) return "unsupported";
  if (trimmed.startsWith("[Error]")) return "error";
  return null;
}

export function parseFileFailureFromResult(
  result: Record<string, unknown>,
): MaterialParseFailure | null {
  const text = typeof result.text === "string" ? result.text : "";
  const error = typeof result.error === "string" ? result.error : "";
  const message = text || error;
  const prefixKind = message ? parseFileFailurePrefixKind(message) : null;
  if (prefixKind) return { kind: prefixKind, message };
  if (result.ok === false) {
    const rawKind = result.failureKind;
    const kind: MaterialParseFailureKind = rawKind === "unsupported" ? "unsupported" : "error";
    return {
      kind,
      message: message || (kind === "unsupported" ? "[Unsupported] 文件格式暂不支持解析。" : "[Error] 文件解析失败。"),
    };
  }
  return null;
}

function stripParseFailurePrefix(message: string): string {
  return message.replace(/^\s*\[(?:Error|Unsupported)\]\s*/i, "").trim();
}

function materialParseErrorText(failure: MaterialParseFailure): string {
  if (failure.parseError) return failure.parseError;
  const clean = stripParseFailurePrefix(failure.message) || "文件解析失败。";
  return failure.kind === "unsupported" ? `不支持解析：${clean}` : `解析失败：${clean}`;
}

function failureFromOutcome(outcome: MaterialParseOutcome): MaterialParseFailure | null {
  if ("ok" in outcome) {
    if (outcome.ok) return null;
    return {
      kind: outcome.failureKind,
      message: outcome.error,
    };
  }
  return outcome;
}

export function stableErrorMaterialId(fileId: string): string {
  return `mat-file-error-${crypto.createHash("sha256").update(fileId).digest("hex").slice(0, 12)}`;
}

export function findMaterialByFileId(state: SessionState, fileId: string): Material | null {
  for (const material of state.materials.values()) {
    if (material.fileId === fileId) return material;
  }
  return null;
}

export function materialToResource(material: Material): Resource {
  return {
    resourceRef: { id: material.id, domain: { kind: "file" } },
    displayName: material.filename,
    summary: material.summary ?? "",
    mime: material.mimeType,
    byteLen: material.text.length,
    createdAt: material.createdAt,
    metadata: { ...material.metadata, fileId: material.fileId, updatedAt: material.updatedAt },
  };
}

export function materialResourceUpsertedFrame(material: Material): BridgeFrame {
  return { kind: "resourceUpserted", data: { resource: materialToResource(material) } };
}

export function buildMaterialFromParse(
  existing: Material | null,
  source: MaterialParseSource,
  outcome: MaterialParseOutcome,
  now = new Date().toISOString(),
): Material {
  const filename = source.filename ?? existing?.filename ?? source.fileId;
  const mimeType = source.mimeType ?? existing?.mimeType ?? "application/octet-stream";
  const materialId = existing?.id ?? stableErrorMaterialId(source.fileId);
  const failure = failureFromOutcome(outcome);

  if (failure) {
    const parseError = materialParseErrorText(failure);
    return {
      id: materialId,
      filename,
      mimeType,
      text: "",
      summary: parseError,
      fileId: source.fileId,
      metadata: {
        pages: null,
        wordCount: 0,
        title: null,
        sourceUrl: existing?.metadata.sourceUrl ?? null,
        parseState: "error",
        parseError,
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  if (!("ok" in outcome) || !outcome.ok) {
    throw new Error("buildMaterialFromParse: 非失败分支缺少成功解析结果");
  }

  const success = outcome;
  return {
    id: materialId,
    filename,
    mimeType,
    text: success.text,
    summary: existing?.metadata.parseState === "error" ? null : existing?.summary ?? null,
    fileId: source.fileId,
    metadata: {
      pages: success.metadata.pages,
      wordCount: success.metadata.wordCount,
      title: success.metadata.title,
      sourceUrl: existing?.metadata.sourceUrl ?? null,
      parseState: "ready",
      parseError: null,
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function upsertMaterialByFileId(
  state: SessionState,
  source: MaterialParseSource,
  outcome: MaterialParseOutcome,
): UpsertMaterialByFileIdResult {
  const existing = findMaterialByFileId(state, source.fileId);
  const material = buildMaterialFromParse(existing, source, outcome);
  state.materials.set(material.id, material);
  return { material, frame: materialResourceUpsertedFrame(material) };
}
