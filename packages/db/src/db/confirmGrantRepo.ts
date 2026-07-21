import { randomUUID } from "node:crypto";
import {
  commitTransaction,
  getDocumentsClient,
  withTransaction,
  withWriteRetry,
} from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

export type ConfirmGrantKind = "install" | "command";
export type ConfirmGrantSource = "card" | "settings";
export type ConfirmAuditKind = ConfirmGrantKind | "connect" | "send";
export type ConfirmDecisionSource = "ui" | "stored-grant" | "expired";
export type ConfirmAuditDecision = "accepted" | "rejected" | "expired" | "failed";
export type ConfirmAuditEventType =
  | "decision_started"
  | "decision_finished"
  | "decision_failed"
  | "decision_expired"
  | "remember_rejected";

export interface ConfirmGrant {
  grantId: string;
  kind: ConfirmGrantKind;
  createdAt: string;
  source: ConfirmGrantSource;
}

export interface ConfirmGrantCreation {
  grant: ConfirmGrant;
  created: boolean;
}

export interface ConfirmAuditEvent {
  eventId: string;
  ts: string;
  eventType: ConfirmAuditEventType;
  subjectId: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  confirmId: string;
  kind: ConfirmAuditKind;
  commandDigest: string;
  commandPreview: string;
  decision: ConfirmAuditDecision;
  source: ConfirmDecisionSource;
  grantId: string | null;
  result: string;
  policyVersion: string;
  isolationEpoch: string | null;
  configHash: string | null;
}

export interface ConfirmGrantEvent {
  eventId: string;
  ts: string;
  grantId: string;
  kind: ConfirmGrantKind;
  action: "created" | "revoked";
  source: ConfirmGrantSource;
  subjectId: string;
}

function mapGrant(row: Record<string, unknown>): ConfirmGrant {
  return {
    grantId: String(row.grant_id),
    kind: String(row.kind) as ConfirmGrantKind,
    createdAt: String(row.created_at),
    source: String(row.source) as ConfirmGrantSource,
  };
}

function mapAuditEvent(row: Record<string, unknown>): ConfirmAuditEvent {
  return {
    eventId: String(row.event_id),
    ts: String(row.ts),
    eventType: String(row.event_type) as ConfirmAuditEventType,
    subjectId: String(row.subject_id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    toolCallId: String(row.tool_call_id),
    confirmId: String(row.confirm_id),
    kind: String(row.kind) as ConfirmAuditKind,
    commandDigest: String(row.command_digest),
    commandPreview: String(row.command_preview),
    decision: String(row.decision) as ConfirmAuditDecision,
    source: String(row.source) as ConfirmDecisionSource,
    grantId: row.grant_id == null ? null : String(row.grant_id),
    result: String(row.result),
    policyVersion: String(row.policy_version),
    isolationEpoch: row.isolation_epoch == null ? null : String(row.isolation_epoch),
    configHash: row.config_hash == null ? null : String(row.config_hash),
  };
}

function mapGrantEvent(row: Record<string, unknown>): ConfirmGrantEvent {
  return {
    eventId: String(row.event_id),
    ts: String(row.ts),
    grantId: String(row.grant_id),
    kind: String(row.kind) as ConfirmGrantKind,
    action: String(row.action) as ConfirmGrantEvent["action"],
    source: String(row.source) as ConfirmGrantSource,
    subjectId: String(row.subject_id),
  };
}

export async function getConfirmGrant(kind: ConfirmGrantKind): Promise<ConfirmGrant | null> {
  await ensureMigrated();
  const result = await getDocumentsClient().execute({
    sql: `SELECT grant_id, kind, created_at, source FROM confirm_grants WHERE kind = ?`,
    args: [kind],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapGrant(row) : null;
}

export async function listConfirmGrants(): Promise<ConfirmGrant[]> {
  await ensureMigrated();
  const result = await getDocumentsClient().execute(
    `SELECT grant_id, kind, created_at, source FROM confirm_grants ORDER BY kind`,
  );
  return result.rows.map((row) => mapGrant(row as Record<string, unknown>));
}

export async function createConfirmGrant(input: {
  kind: ConfirmGrantKind;
  source: ConfirmGrantSource;
  grantId?: string;
  now?: string;
  subjectId?: string;
}): Promise<ConfirmGrant> {
  return (await createConfirmGrantWithResult(input)).grant;
}

/**
 * 原子地确保某类 grant 存在，并告诉调用方本次是否真的完成了首次创建。
 * UI 只可在 created=true 时提示“已记住”，不能把命中既有记录误报为新设置。
 */
export async function createConfirmGrantWithResult(input: {
  kind: ConfirmGrantKind;
  source: ConfirmGrantSource;
  grantId?: string;
  now?: string;
  subjectId?: string;
}): Promise<ConfirmGrantCreation> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const existing = await client.execute({
      sql: `SELECT grant_id, kind, created_at, source FROM confirm_grants WHERE kind = ?`,
      args: [input.kind],
    });
    const row = existing.rows[0] as Record<string, unknown> | undefined;
    if (row) {
      return commitTransaction<ConfirmGrantCreation>({
        grant: mapGrant(row),
        created: false,
      });
    }

    const grant: ConfirmGrant = {
      grantId: input.grantId ?? randomUUID(),
      kind: input.kind,
      createdAt: input.now ?? new Date().toISOString(),
      source: input.source,
    };
    await client.execute({
      sql: `INSERT INTO confirm_grants (kind, grant_id, created_at, source) VALUES (?, ?, ?, ?)`,
      args: [grant.kind, grant.grantId, grant.createdAt, grant.source],
    });
    await client.execute({
      sql: `INSERT INTO confirm_grant_events (
        event_id, ts, grant_id, kind, action, source, subject_id
      ) VALUES (?, ?, ?, ?, 'created', ?, ?)`,
      args: [
        randomUUID(),
        grant.createdAt,
        grant.grantId,
        grant.kind,
        grant.source,
        input.subjectId ?? "local-user",
      ],
    });
    return commitTransaction<ConfirmGrantCreation>({ grant, created: true });
  });
}

export async function revokeConfirmGrant(
  kind: ConfirmGrantKind,
  source: ConfirmGrantSource = "settings",
  now = new Date().toISOString(),
  subjectId = "local-user",
): Promise<ConfirmGrant | null> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const existing = await client.execute({
      sql: `SELECT grant_id, kind, created_at, source FROM confirm_grants WHERE kind = ?`,
      args: [kind],
    });
    const row = existing.rows[0] as Record<string, unknown> | undefined;
    if (!row) return commitTransaction(null);
    const grant = mapGrant(row);
    await client.execute({ sql: `DELETE FROM confirm_grants WHERE kind = ?`, args: [kind] });
    await client.execute({
      sql: `INSERT INTO confirm_grant_events (
        event_id, ts, grant_id, kind, action, source, subject_id
      ) VALUES (?, ?, ?, ?, 'revoked', ?, ?)`,
      args: [randomUUID(), now, grant.grantId, grant.kind, source, subjectId],
    });
    return commitTransaction(grant);
  });
}

export async function appendConfirmAuditEvent(
  input: Omit<ConfirmAuditEvent, "eventId" | "ts"> & { eventId?: string; ts?: string },
): Promise<ConfirmAuditEvent> {
  await ensureMigrated();
  const event: ConfirmAuditEvent = {
    ...input,
    eventId: input.eventId ?? randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
  };
  await withWriteRetry(() => getDocumentsClient().execute({
    sql: `INSERT INTO confirm_audit_events (
      event_id, ts, event_type, subject_id, session_id, run_id, tool_call_id, confirm_id,
      kind, command_digest, command_preview, decision, source, grant_id,
      result, policy_version, isolation_epoch, config_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      event.eventId,
      event.ts,
      event.eventType,
      event.subjectId,
      event.sessionId,
      event.runId,
      event.toolCallId,
      event.confirmId,
      event.kind,
      event.commandDigest,
      event.commandPreview,
      event.decision,
      event.source,
      event.grantId,
      event.result,
      event.policyVersion,
      event.isolationEpoch,
      event.configHash,
    ],
  }));
  return event;
}

export async function listConfirmAuditEvents(sessionId?: string): Promise<ConfirmAuditEvent[]> {
  await ensureMigrated();
  const result = sessionId
    ? await getDocumentsClient().execute({
        sql: `SELECT * FROM confirm_audit_events WHERE session_id = ? ORDER BY ts, event_id`,
        args: [sessionId],
      })
    : await getDocumentsClient().execute(`SELECT * FROM confirm_audit_events ORDER BY ts, event_id`);
  return result.rows.map((row) => mapAuditEvent(row as Record<string, unknown>));
}

export async function listConfirmGrantEvents(): Promise<ConfirmGrantEvent[]> {
  await ensureMigrated();
  const result = await getDocumentsClient().execute(
    `SELECT * FROM confirm_grant_events ORDER BY ts, event_id`,
  );
  return result.rows.map((row) => mapGrantEvent(row as Record<string, unknown>));
}
