import type { Client, Row } from "@libsql/client";
import type { PmStep } from "@qingagent/pm-schema";
import { getDocumentsClient, withWriteRetry } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";
import type { DocumentVersionActorType } from "./documentVersionRepo.js";

export type DocumentOpKind = "replace_doc" | "patch_steps";

export interface DocumentOpRow {
  opId: string;
  docId: string;
  opKind: DocumentOpKind;
  clientMutationId: string | null;
  steps: PmStep[] | null;
  fromVersion: number;
  toVersion: number;
  actorType: DocumentVersionActorType;
  createdAt: string;
}

export interface InsertDocumentOpInput {
  opId: string;
  docId: string;
  opKind: DocumentOpKind;
  clientMutationId?: string | null;
  steps?: PmStep[] | null;
  fromVersion: number;
  toVersion: number;
  actorType: DocumentVersionActorType;
  createdAt: string;
}

export interface FindDocumentOpKey {
  opId?: string | null;
  clientMutationId?: string | null;
}

function valueAsString(value: unknown): string {
  return value == null ? "" : String(value);
}

function valueAsNullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function valueAsNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function parseSteps(value: unknown): PmStep[] | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new Error("Invalid document_ops.steps: expected JSON string");
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid document_ops.steps: expected array");
  }
  return parsed as PmStep[];
}

async function readyClient(client?: Client): Promise<Client> {
  const c = client ?? getDocumentsClient();
  await ensureMigrated();
  return c;
}

function mapOpRow(row: Row): DocumentOpRow {
  return {
    opId: valueAsString(row.op_id),
    docId: valueAsString(row.doc_id),
    opKind: valueAsString(row.op_kind) as DocumentOpKind,
    clientMutationId: valueAsNullableString(row.client_mutation_id),
    steps: parseSteps(row.steps),
    fromVersion: valueAsNumber(row.from_version),
    toVersion: valueAsNumber(row.to_version),
    actorType: valueAsString(row.actor_type) as DocumentVersionActorType,
    createdAt: valueAsString(row.created_at),
  };
}

function normalizeKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function insertOp(
  input: InsertDocumentOpInput,
  client?: Client,
): Promise<void> {
  const c = await readyClient(client);
  await withWriteRetry(async () => {
    await c.execute({
      sql: `INSERT INTO document_ops (
          op_id, doc_id, op_kind, client_mutation_id, steps,
          from_version, to_version, actor_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.opId,
        input.docId,
        input.opKind,
        input.clientMutationId ?? null,
        input.steps ? JSON.stringify(input.steps) : null,
        input.fromVersion,
        input.toVersion,
        input.actorType,
        input.createdAt,
      ],
    });
  });
}

export async function findOpByIdempotencyKey(
  key: FindDocumentOpKey,
  client?: Client,
): Promise<DocumentOpRow | null> {
  const opId = normalizeKey(key.opId);
  const clientMutationId = normalizeKey(key.clientMutationId);
  if (!opId && !clientMutationId) return null;

  const c = await readyClient(client);
  const clauses: string[] = [];
  const args: string[] = [];
  if (opId) {
    clauses.push("op_id = ?");
    args.push(opId);
  }
  if (clientMutationId) {
    clauses.push("client_mutation_id = ?");
    args.push(clientMutationId);
  }
  const result = await c.execute({
    sql: `SELECT * FROM document_ops WHERE ${clauses.join(" OR ")} LIMIT 1`,
    args,
  });
  const row = result.rows[0];
  return row ? mapOpRow(row) : null;
}

/**
 * 精确读取某个文档版本对应的提交记录。
 *
 * 恢复崩溃窗口时不能按 created_at 猜“最近一笔”，因为同毫秒提交或异常时钟都
 * 可能选错；doc_id + to_version 才是正文版本与 op 的稳定关联键。
 */
export async function findOpByDocumentVersion(
  docId: string,
  toVersion: number,
  client?: Client,
): Promise<DocumentOpRow | null> {
  const c = await readyClient(client);
  const result = await c.execute({
    sql: "SELECT * FROM document_ops WHERE doc_id = ? AND to_version = ? LIMIT 1",
    args: [docId, toVersion],
  });
  const row = result.rows[0];
  return row ? mapOpRow(row) : null;
}
