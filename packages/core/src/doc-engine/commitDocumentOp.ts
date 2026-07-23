import type { Client, Row } from "@qingagent/db";
import type { PatchConflict } from "@qingagent/contract-ts";
import {
  getDeterministicId,
  getPmContentHash,
  safeParsePmDoc,
  type PmDoc,
  type PmStep,
} from "@qingagent/pm-schema";
import {
  buildPmProjection,
  parsePmDoc,
} from "@qingagent/db";
import {
  assertDocumentWriteAllowed,
  DocumentWriteBlockedError,
} from "@qingagent/db/write-guard";
import {
  commitTransaction,
  rollbackTransaction,
  withTransaction,
} from "@qingagent/db";
import {
  findOpByDocumentVersion,
  findOpByIdempotencyKey,
  insertOp,
  type DocumentOpKind,
  type DocumentOpRow,
} from "@qingagent/db";
import type { SessionState } from "../session/sessionState.js";
import { ensureMigrated } from "@qingagent/db";
import {
  getLatestVersionRow,
  getMaxDocumentSnapshotVersion,
  getVersionSnapshotByDocumentSnapshot,
  insertVersion,
  rollVersionRow,
  type DocumentVersionActorType,
} from "@qingagent/db";
import { runExclusiveCommit } from "./docCommitQueue.js";

/**
 * 幂等键：clientMutationId（用户编辑保存）与 opId（patch commit / 生成）至少传一个。
 * 调用方提供 clientMutationId 时由该 mutation 身份主导幂等判断；只有运行时通过 any
 * 透传导致两者皆空时，才按 (docId, opKind, contentHash(apply 结果)) 派生兜底 opId。
 */
export type CommitIdempotencyKey =
  | { clientMutationId: string; opId?: string }
  | { opId: string; clientMutationId?: string };

export interface PmValidationError {
  path: Array<string | number>;
  message: string;
  code?: string;
}

export interface CommitDocumentOpBaseInput {
  docId: string;
  threadId: string | null;
  resourceId: string;
  expectedDocumentSnapshot: number;
  createIfMissing?: {
    title: string;
    docState: string;
    lastSyncedVersion: number;
  };
  baseContentHash?: string;
  opKind: DocumentOpKind;
  actorType: DocumentVersionActorType;
  coalesce?: {
    windowMs: number;
  };
  apply: (currentDoc: PmDoc) => {
    nextDoc: PmDoc;
    steps?: PmStep[];
    conflicts?: PatchConflict[];
  };
  /**
   * 版本摘要可延迟到 apply 完成后计算，供部分成功的 patch 提交按真实 applied/conflict
   * 数量记账；普通写入仍直接传字符串。
   */
  summary?: string | (() => string);
}

export type CommitDocumentOpInput = CommitDocumentOpBaseInput & CommitIdempotencyKey;

export type CommitDocumentOpResult =
  | {
      status: "committed";
      docVersion: number;
      contentHash: string;
      doc: PmDoc;
      versionId: string;
      /** 本次调用是否成功插入新 op 并产生了新文档版本。 */
      createdNewVersion: boolean;
      /** 对应 document_ops.created_at；幂等回放返回既有 op 的原始时间。 */
      committedAt: string;
      /** 实际落库的 steps；幂等回放从 document_ops 恢复，供调用方如实续办结算。 */
      steps?: PmStep[];
      conflicts?: PatchConflict[];
    }
  | { status: "conflict"; currentVersion: number; currentHash: string }
  | {
      status: "patch_conflict";
      currentVersion: number;
      currentHash: string;
      conflicts: PatchConflict[];
    }
  | { status: "not_found" }
  | { status: "validation_error"; errors: PmValidationError[] };

export interface CommitDocumentOpOptions {
  now?: () => string;
  makeVersionId?: (input: {
    docId: string;
    docVersion: number;
    contentHash: string;
  }) => string;
  hooks?: {
    afterDocumentUpdate?: () => void | Promise<void>;
    afterVersionInsert?: () => void | Promise<void>;
    afterOpInsert?: () => void | Promise<void>;
  };
}

interface CurrentDocumentForCommit {
  docVersion: number;
  contentHash: string;
  pmDoc: PmDoc;
  updatedAt: string;
}

function valueAsNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function normalizeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validationErrorsFrom(error: {
  issues: Array<{ path: PropertyKey[]; message: string; code?: string }>;
} | undefined): PmValidationError[] {
  if (!error) return [];
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) =>
      typeof segment === "symbol" ? segment.toString() : segment,
    ),
    message: issue.message,
    code: issue.code,
  }));
}

function deriveOpId(input: {
  docId: string;
  opKind: DocumentOpKind;
  contentHash: string;
}): string {
  return getDeterministicId("op", input);
}

function deriveClientMutationOpId(docId: string, clientMutationId: string): string {
  return getDeterministicId("op", { docId, clientMutationId });
}

function defaultVersionId(input: {
  docId: string;
  docVersion: number;
  contentHash: string;
}): string {
  return getDeterministicId("version", input);
}

function readCurrentDocument(row: Row): CurrentDocumentForCommit {
  const rawDocPm = row.doc_pm;
  if (typeof rawDocPm !== "string" || rawDocPm.trim().length === 0) {
    throw new Error("Invalid documents.doc_pm: PM document is required");
  }
  const pmDoc = parsePmDoc(rawDocPm);
  return {
    docVersion: valueAsNumber(row.doc_version),
    contentHash: getPmContentHash(pmDoc),
    pmDoc,
    updatedAt: String(row.updated_at ?? ""),
  };
}

function emptyPmDoc(): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content: [] };
}

async function getCurrentDocument(
  client: Client,
  docId: string,
): Promise<CurrentDocumentForCommit | null> {
  const result = await client.execute({
    sql: "SELECT * FROM documents WHERE id = ?",
    args: [docId],
  });
  const row = result.rows[0];
  return row ? readCurrentDocument(row) : null;
}

function coalesceWindowMs(input: CommitDocumentOpInput): number {
  const raw = input.coalesce?.windowMs;
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function canCoalesceUserVersion(input: CommitDocumentOpInput): boolean {
  return input.opKind === "replace_doc" && input.actorType === "user" && coalesceWindowMs(input) > 0;
}

function isWithinCoalesceWindow(input: {
  now: string;
  createdAt: string;
  windowMs: number;
}): boolean {
  const nowMs = Date.parse(input.now);
  const createdAtMs = Date.parse(input.createdAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(createdAtMs)) return false;
  return nowMs - createdAtMs < input.windowMs;
}

async function committedResultFromOp(
  op: DocumentOpRow,
  client: Client,
): Promise<Extract<CommitDocumentOpResult, { status: "committed" }>> {
  const version = await getVersionSnapshotByDocumentSnapshot(op.docId, op.toVersion, client);
  if (version) {
    return {
      status: "committed",
      docVersion: version.docVersion,
      contentHash: version.contentHash,
      doc: version.snapshotPm,
      versionId: version.versionId,
      createdNewVersion: false,
      committedAt: op.createdAt,
      steps: op.steps ?? undefined,
    };
  }

  // 用户编辑版本会按 60s 窗口折叠: document_ops 仍记录真实逐笔 toVersion,
  // 但中间 toVersion 对应的 document_versions 行可能已被滚动到窗口最终版本。
  const latestVersion = await getLatestVersionRow(op.docId, client);
  if (latestVersion) {
    return {
      status: "committed",
      docVersion: latestVersion.docVersion,
      contentHash: latestVersion.contentHash,
      doc: latestVersion.snapshotPm,
      versionId: latestVersion.versionId,
      createdNewVersion: false,
      committedAt: op.createdAt,
      steps: op.steps ?? undefined,
    };
  }

  const current = await getCurrentDocument(client, op.docId);
  if (current) {
    return {
      status: "committed",
      docVersion: current.docVersion,
      contentHash: current.contentHash,
      doc: current.pmDoc,
      versionId: defaultVersionId({
        docId: op.docId,
        docVersion: current.docVersion,
        contentHash: current.contentHash,
      }),
      createdNewVersion: false,
      committedAt: op.createdAt,
      steps: op.steps ?? undefined,
    };
  }
  throw new Error(`document_ops points to missing document: ${op.opId}`);
}

/**
 * 仅在本次事务真实创建新版本、且版本相对提交前内存状态向前时推进首页排序键。
 * 调用方必须在 commitDocumentOp 前捕获 previousDocVersion，不能覆盖 state.docVersion
 * 后再读取。
 */
export function advanceLastContentEditedAt(
  state: Pick<SessionState, "lastContentEditedAt">,
  result: CommitDocumentOpResult,
  previousDocVersion: number,
): boolean {
  if (
    result.status === "committed" &&
    result.createdNewVersion &&
    result.docVersion > previousDocVersion
  ) {
    state.lastContentEditedAt = result.committedAt;
    return true;
  }
  return false;
}

/** 精确读取某个 docVersion 对应 op 的真实提交时间，供冷/热崩溃恢复共用。 */
export async function getDocumentVersionCommittedAt(
  docId: string,
  docVersion: number,
): Promise<string | null> {
  const op = await findOpByDocumentVersion(docId, docVersion);
  return op?.createdAt ?? null;
}

function validateNextDoc(nextDoc: PmDoc): {
  ok: true;
  doc: PmDoc;
} | {
  ok: false;
  errors: PmValidationError[];
} {
  const parsed = safeParsePmDoc(nextDoc);
  if (!parsed.success) {
    return { ok: false, errors: validationErrorsFrom(parsed.error) };
  }
  return { ok: true, doc: parsed.data as PmDoc };
}

async function maybeReturnDerivedIdempotentResult(input: {
  currentDoc: PmDoc;
  docId: string;
  opKind: DocumentOpKind;
  apply: CommitDocumentOpBaseInput["apply"];
  client: Client;
}): Promise<Extract<CommitDocumentOpResult, { status: "committed" }> | null> {
  const applied = input.apply(input.currentDoc);
  const validation = validateNextDoc(applied.nextDoc);
  if (!validation.ok) return null;
  const opId = deriveOpId({
    docId: input.docId,
    opKind: input.opKind,
    contentHash: getPmContentHash(validation.doc),
  });
  const op = await findOpByIdempotencyKey({ docId: input.docId, opId }, input.client);
  return op ? committedResultFromOp(op, input.client) : null;
}

export async function commitDocumentOp(
  input: CommitDocumentOpInput,
  options: CommitDocumentOpOptions = {},
): Promise<CommitDocumentOpResult> {
  await ensureMigrated();

  const providedOpId = normalizeKey((input as { opId?: unknown }).opId);
  const providedClientMutationId = normalizeKey(
    (input as { clientMutationId?: unknown }).clientMutationId,
  );
  const now = options.now ?? (() => new Date().toISOString());
  const makeVersionId = options.makeVersionId ?? defaultVersionId;

  const runTransaction = () => withTransaction<CommitDocumentOpResult>(async (client) => {
    let current = await getCurrentDocument(client, input.docId);
    const snapshotHighWater = await getMaxDocumentSnapshotVersion(input.docId, client);

    const existingOp = await findOpByIdempotencyKey(
      { docId: input.docId, opId: providedOpId, clientMutationId: providedClientMutationId },
      client,
    );
    if (existingOp) {
      return rollbackTransaction(await committedResultFromOp(existingOp, client));
    }

    const creating = current === null && input.createIfMissing !== undefined;
    if (!current) {
      if (!input.createIfMissing || input.expectedDocumentSnapshot !== 0) {
        return rollbackTransaction({ status: "not_found" } satisfies CommitDocumentOpResult);
      }
      const pmDoc = emptyPmDoc();
      current = {
        docVersion: 0,
        contentHash: getPmContentHash(pmDoc),
        pmDoc,
        updatedAt: "",
      };
    }

    const currentHighWater = Math.max(current.docVersion, snapshotHighWater ?? 0);

    if (snapshotHighWater !== null && snapshotHighWater > current.docVersion) {
      return rollbackTransaction({
        status: "conflict",
        currentVersion: currentHighWater,
        currentHash: current.contentHash,
      } satisfies CommitDocumentOpResult);
    }

    if (
      current.docVersion !== input.expectedDocumentSnapshot ||
      (input.baseContentHash && current.contentHash !== input.baseContentHash)
    ) {
      if (!providedOpId && !providedClientMutationId) {
        const idempotent = await maybeReturnDerivedIdempotentResult({
          currentDoc: current.pmDoc,
          docId: input.docId,
          opKind: input.opKind,
          apply: input.apply,
          client,
        });
        if (idempotent) return rollbackTransaction(idempotent);
      }
      return rollbackTransaction({
        status: "conflict",
        currentVersion: currentHighWater,
        currentHash: current.contentHash,
      } satisfies CommitDocumentOpResult);
    }

    const applied = input.apply(current.pmDoc);
    if (applied.conflicts && applied.conflicts.length > 0) {
      return rollbackTransaction({
        status: "patch_conflict",
        currentVersion: currentHighWater,
        currentHash: current.contentHash,
        conflicts: applied.conflicts,
      } satisfies CommitDocumentOpResult);
    }
    const validation = validateNextDoc(applied.nextDoc);
    if (!validation.ok) {
      return rollbackTransaction({
        status: "validation_error",
        errors: validation.errors,
      } satisfies CommitDocumentOpResult);
    }

    const nextDoc = validation.doc;
    const contentHash = getPmContentHash(nextDoc);
    // 乐观锁必须先于等值判断：旧基线即使提交内容碰巧与当前 canonical 相同，
    // 也不能伪装成已消费当前版本。基线有效且用户整篇保存的正文未变时直接确认
    // 当前版本，不写 documents / document_versions / document_ops，也不滚动
    // coalesce 窗口。patch/生成保留既有结算与幂等语义，不在这里扩大 no-op 范围。
    if (
      !creating &&
      providedClientMutationId &&
      input.opKind === "replace_doc" &&
      input.actorType === "user" &&
      contentHash === current.contentHash
    ) {
      const currentVersion = await getVersionSnapshotByDocumentSnapshot(
        input.docId,
        current.docVersion,
        client,
      );
      return rollbackTransaction({
        status: "committed",
        docVersion: current.docVersion,
        contentHash: current.contentHash,
        doc: current.pmDoc,
        versionId: currentVersion?.versionId ?? defaultVersionId({
          docId: input.docId,
          docVersion: current.docVersion,
          contentHash: current.contentHash,
        }),
        createdNewVersion: false,
        committedAt: currentVersion?.createdAt || current.updatedAt || now(),
      } satisfies CommitDocumentOpResult);
    }
    const opId = providedOpId
      ?? (providedClientMutationId
        ? deriveClientMutationOpId(input.docId, providedClientMutationId)
        : deriveOpId({
            docId: input.docId,
            opKind: input.opKind,
            contentHash,
          }));
    const derivedExistingOp = await findOpByIdempotencyKey(
      { docId: input.docId, opId, clientMutationId: providedClientMutationId },
      client,
    );
    if (derivedExistingOp) {
      return rollbackTransaction(await committedResultFromOp(derivedExistingOp, client));
    }

    const nextVersion = currentHighWater + 1;
    const createdAt = now();
    const versionId = makeVersionId({
      docId: input.docId,
      docVersion: nextVersion,
      contentHash,
    });
    const projection = buildPmProjection({ pmDoc: nextDoc });

    assertDocumentWriteAllowed({
      docId: input.docId,
      threadId: input.threadId,
      operation: "document.commit",
    });

    if (creating) {
      const insertResult = await client.execute({
        sql: `INSERT INTO documents (
            id, thread_id, resource_id, title, doc_state, doc_version,
            last_synced_version, doc_pm, doc_schema_version,
            content_hash, doc_format, version, created_at, updated_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM deleted_sessions WHERE session_id IN (?, ?)
          )`,
        args: [
          input.docId,
          input.threadId ?? input.docId,
          input.resourceId,
          input.createIfMissing!.title,
          input.createIfMissing!.docState,
          nextVersion,
          input.createIfMissing!.lastSyncedVersion,
          projection.pmJson,
          projection.schemaVersion,
          contentHash,
          projection.docFormat,
          createdAt,
          createdAt,
          input.threadId ?? input.docId,
          input.docId,
        ],
      });
      if (insertResult.rowsAffected === 0) {
        throw new DocumentWriteBlockedError({
          docId: input.docId,
          threadId: input.threadId,
          operation: "document.commit",
        });
      }
    } else {
      const updateResult = await client.execute({
        sql: `UPDATE documents SET
          doc_pm = ?,
          doc_schema_version = ?,
          content_hash = ?,
          doc_format = ?,
          doc_version = ?,
          version = version + 1,
          updated_at = ?
        WHERE id = ? AND doc_version = ?`,
      args: [
        projection.pmJson,
        projection.schemaVersion,
        contentHash,
        projection.docFormat,
        nextVersion,
        createdAt,
        input.docId,
        input.expectedDocumentSnapshot,
      ],
      });
      if (updateResult.rowsAffected === 0) {
        const latest = await getCurrentDocument(client, input.docId);
        const latestSnapshotHighWater = await getMaxDocumentSnapshotVersion(input.docId, client);
        const latestVersion = Math.max(
          latest?.docVersion ?? current.docVersion,
          latestSnapshotHighWater ?? currentHighWater,
        );
        return rollbackTransaction({
          status: "conflict",
          currentVersion: latestVersion,
          currentHash: latest?.contentHash ?? current.contentHash,
        } satisfies CommitDocumentOpResult);
      }
    }
    await options.hooks?.afterDocumentUpdate?.();

    let committedVersionId = versionId;
    const coalesceMs = coalesceWindowMs(input);
    const latestVersion = canCoalesceUserVersion(input)
      ? await getLatestVersionRow(input.docId, client)
      : null;
    if (
      latestVersion?.actorType === "user" &&
      isWithinCoalesceWindow({
        now: createdAt,
        createdAt: latestVersion.createdAt,
        windowMs: coalesceMs,
      })
    ) {
      await rollVersionRow(
        {
          versionId: latestVersion.versionId,
          docId: input.docId,
          docVersion: nextVersion,
          contentHash,
          schemaVersion: projection.schemaVersion,
          snapshotPm: nextDoc,
        },
        client,
      );
      committedVersionId = latestVersion.versionId;
    } else {
      await insertVersion(
        {
          versionId,
          docId: input.docId,
          docVersion: nextVersion,
          contentHash,
          schemaVersion: projection.schemaVersion,
          actorType: input.actorType,
          summary: typeof input.summary === "function" ? input.summary() : input.summary ?? null,
          snapshotPm: nextDoc,
          parentVersion: currentHighWater,
          createdAt,
        },
        client,
      );
    }
    await options.hooks?.afterVersionInsert?.();

    await insertOp(
      {
        opId,
        docId: input.docId,
        opKind: input.opKind,
        clientMutationId: providedClientMutationId,
        steps: applied.steps ?? null,
        fromVersion: currentHighWater,
        toVersion: nextVersion,
        actorType: input.actorType,
        createdAt,
      },
      client,
    );
    await options.hooks?.afterOpInsert?.();

    return commitTransaction({
      status: "committed",
      docVersion: nextVersion,
      contentHash,
      doc: nextDoc,
      versionId: committedVersionId,
      createdNewVersion: true,
      committedAt: createdAt,
      steps: applied.steps,
      conflicts: applied.conflicts,
    } satisfies CommitDocumentOpResult);
  });

  return runExclusiveCommit(runTransaction);
}
