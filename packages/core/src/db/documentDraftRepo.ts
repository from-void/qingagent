import type { Client, Row } from "@libsql/client";
import {
  getStablePmJson,
  normalizePmDoc,
  type PmDoc,
} from "@qingagent/pm-schema";
import { getDocumentsClient, withWriteRetry } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

export type DocumentDraftStatus = "draft_candidate" | "pending_review" | "conflict";
export type DocumentDraftGroupMode = "atomic" | "independent";

export interface DocumentDraftRow {
  docId: string;
  threadId: string;
  baseVersion: number;
  baseHash: string;
  draftPmDoc: PmDoc;
  status: DocumentDraftStatus;
  conflict: unknown | null;
  reviewBatchId: string | null;
  groupMode: DocumentDraftGroupMode | null;
  sourceStreamId: string | null;
  sourceToolCallId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavePendingDraftInput {
  docId: string;
  threadId: string;
  baseVersion: number;
  baseHash: string;
  draftPmDoc: PmDoc;
  reviewBatchId?: string | null;
  groupMode?: DocumentDraftGroupMode | null;
  sourceStreamId?: string | null;
  sourceToolCallId?: string | null;
}

export interface SaveCandidateDraftInput {
  docId: string;
  threadId: string;
  baseVersion: number;
  baseHash: string;
  draftPmDoc: PmDoc;
  sourceStreamId: string;
  sourceToolCallId?: string | null;
}

export interface MarkDraftConflictInput {
  docId: string;
  conflict: unknown;
}

function valueAsString(value: unknown): string {
  return value == null ? "" : String(value);
}

function valueAsNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function parseStatus(value: unknown): DocumentDraftStatus {
  const status = valueAsString(value);
  if (status === "draft_candidate" || status === "pending_review" || status === "conflict") {
    return status;
  }
  throw new Error(`Invalid document_drafts.status: ${status}`);
}

function parseGroupMode(value: unknown): DocumentDraftGroupMode | null {
  if (value == null || value === "") return null;
  const mode = String(value);
  if (mode === "atomic" || mode === "independent") return mode;
  throw new Error(`Invalid document_drafts.group_mode: ${mode}`);
}

function parseDraftPm(value: unknown): PmDoc {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Invalid document_drafts.draft_pm: expected JSON string");
  }
  return normalizePmDoc(JSON.parse(value) as unknown);
}

function parseConflict(value: unknown): unknown | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return JSON.parse(value) as unknown;
}

function mapRow(row: Row): DocumentDraftRow {
  return {
    docId: valueAsString(row.doc_id),
    threadId: valueAsString(row.thread_id),
    baseVersion: valueAsNumber(row.base_version),
    baseHash: valueAsString(row.base_hash),
    draftPmDoc: parseDraftPm(row.draft_pm),
    status: parseStatus(row.status),
    conflict: parseConflict(row.conflict_json),
    reviewBatchId: valueAsString(row.review_batch_id) || null,
    groupMode: parseGroupMode(row.group_mode),
    sourceStreamId: valueAsString(row.source_stream_id) || null,
    sourceToolCallId: valueAsString(row.source_tool_call_id) || null,
    createdAt: valueAsString(row.created_at),
    updatedAt: valueAsString(row.updated_at),
  };
}

async function readyClient(client?: Client): Promise<Client> {
  const c = client ?? getDocumentsClient();
  await ensureMigrated();
  return c;
}

export async function loadDocumentDraft(
  docId: string,
  client?: Client,
): Promise<DocumentDraftRow | null> {
  const c = await readyClient(client);
  const result = await c.execute({
    sql: "SELECT * FROM document_drafts WHERE doc_id = ?",
    args: [docId],
  });
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function savePendingDocumentDraft(
  input: SavePendingDraftInput,
  client?: Client,
  now = new Date().toISOString(),
): Promise<void> {
  const c = await readyClient(client);
  const draftPmDoc = normalizePmDoc(input.draftPmDoc);
  const draftPmJson = getStablePmJson(draftPmDoc);
  await withWriteRetry(async () => {
    await c.execute({
      sql: `INSERT INTO document_drafts (
          doc_id, thread_id, base_version, base_hash, draft_pm, status,
          conflict_json, review_batch_id, group_mode, source_stream_id,
          source_tool_call_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending_review', NULL, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          base_version = excluded.base_version,
          base_hash = excluded.base_hash,
          draft_pm = excluded.draft_pm,
          status = 'pending_review',
          conflict_json = NULL,
          review_batch_id = excluded.review_batch_id,
          group_mode = excluded.group_mode,
          source_stream_id = excluded.source_stream_id,
          source_tool_call_id = excluded.source_tool_call_id,
          updated_at = excluded.updated_at`,
      args: [
        input.docId,
        input.threadId,
        input.baseVersion,
        input.baseHash,
        draftPmJson,
        input.reviewBatchId ?? null,
        input.groupMode ?? null,
        input.sourceStreamId ?? null,
        input.sourceToolCallId ?? null,
        now,
        now,
      ],
    });
  });
}

export async function saveCandidateDocumentDraft(
  input: SaveCandidateDraftInput,
  client?: Client,
  now = new Date().toISOString(),
): Promise<void> {
  const c = await readyClient(client);
  const draftPmDoc = normalizePmDoc(input.draftPmDoc);
  const draftPmJson = getStablePmJson(draftPmDoc);
  await withWriteRetry(async () => {
    await c.execute({
      sql: `INSERT INTO document_drafts (
          doc_id, thread_id, base_version, base_hash, draft_pm, status,
          conflict_json, review_batch_id, group_mode, source_stream_id,
          source_tool_call_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'draft_candidate', NULL, NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          base_version = excluded.base_version,
          base_hash = excluded.base_hash,
          draft_pm = excluded.draft_pm,
          status = 'draft_candidate',
          conflict_json = NULL,
          review_batch_id = NULL,
          group_mode = NULL,
          source_stream_id = excluded.source_stream_id,
          source_tool_call_id = excluded.source_tool_call_id,
          updated_at = excluded.updated_at`,
      args: [
        input.docId,
        input.threadId,
        input.baseVersion,
        input.baseHash,
        draftPmJson,
        input.sourceStreamId,
        input.sourceToolCallId ?? null,
        now,
        now,
      ],
    });
  });
}

export async function markDocumentDraftConflict(
  input: MarkDraftConflictInput,
  client?: Client,
  now = new Date().toISOString(),
): Promise<void> {
  const c = await readyClient(client);
  await withWriteRetry(async () => {
    await c.execute({
      sql: `UPDATE document_drafts
        SET status = 'conflict', conflict_json = ?, updated_at = ?
        WHERE doc_id = ?`,
      args: [JSON.stringify(input.conflict), now, input.docId],
    });
  });
}

export async function clearDocumentDraft(
  docId: string,
  client?: Client,
): Promise<void> {
  const c = await readyClient(client);
  await withWriteRetry(async () => {
    await c.execute({
      sql: "DELETE FROM document_drafts WHERE doc_id = ?",
      args: [docId],
    });
  });
}

export const documentDraftRepo = {
  load: loadDocumentDraft,
  savePending: savePendingDocumentDraft,
  saveCandidate: saveCandidateDocumentDraft,
  markConflict: markDocumentDraftConflict,
  clear: clearDocumentDraft,
};
