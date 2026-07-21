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

export interface ConfirmGrantCanonical {
  present: boolean;
  grantId: string | null;
  version: number;
}

export interface ConfirmGrantState extends ConfirmGrantCanonical {
  kind: ConfirmGrantKind;
  revocationEpoch: number;
  grant: ConfirmGrant | null;
}

export interface ConfirmGrantMutation {
  state: ConfirmGrantState;
  grant: ConfirmGrant | null;
  created: boolean;
  stale: boolean;
}

export interface ConfirmGrantRevocation {
  state: ConfirmGrantState;
  revokedGrant: ConfirmGrant | null;
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

function mapGrantState(
  kind: ConfirmGrantKind,
  version: number,
  revocationEpoch: number,
  grant: ConfirmGrant | null,
): ConfirmGrantState {
  return {
    kind,
    present: grant !== null,
    grantId: grant?.grantId ?? null,
    version,
    revocationEpoch,
    grant,
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

export async function getConfirmGrantState(kind: ConfirmGrantKind): Promise<ConfirmGrantState> {
  await ensureMigrated();
  const result = await getDocumentsClient().execute({
    sql: `SELECT
      state.version,
      state.revocation_epoch,
      grant.grant_id,
      grant.kind AS grant_kind,
      grant.created_at,
      grant.source
    FROM confirm_grant_states AS state
    LEFT JOIN confirm_grants AS grant ON grant.kind = state.kind
    WHERE state.kind = ?`,
    args: [kind],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error(`confirm grant state missing for ${kind}`);
  const grant = row.grant_id == null
    ? null
    : mapGrant({
        grant_id: row.grant_id,
        kind: row.grant_kind,
        created_at: row.created_at,
        source: row.source,
      });
  return mapGrantState(kind, Number(row.version), Number(row.revocation_epoch), grant);
}

export async function listConfirmGrants(): Promise<ConfirmGrant[]> {
  await ensureMigrated();
  const result = await getDocumentsClient().execute(
    `SELECT grant_id, kind, created_at, source FROM confirm_grants ORDER BY kind`,
  );
  return result.rows.map((row) => mapGrant(row as Record<string, unknown>));
}

export async function listConfirmGrantStates(): Promise<ConfirmGrantState[]> {
  await ensureMigrated();
  const result = await getDocumentsClient().execute(
    `SELECT
      state.kind,
      state.version,
      state.revocation_epoch,
      grant.grant_id,
      grant.created_at,
      grant.source
    FROM confirm_grant_states AS state
    LEFT JOIN confirm_grants AS grant ON grant.kind = state.kind
    ORDER BY state.kind`,
  );
  return result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const kind = String(row.kind) as ConfirmGrantKind;
    const grant = row.grant_id == null
      ? null
      : mapGrant({
          grant_id: row.grant_id,
          kind,
          created_at: row.created_at,
          source: row.source,
        });
    return mapGrantState(kind, Number(row.version), Number(row.revocation_epoch), grant);
  });
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
  const mutation = await createConfirmGrantCanonical(input);
  if (!mutation.grant) {
    throw new Error(`confirm grant creation unexpectedly rejected for ${input.kind}`);
  }
  return { grant: mutation.grant, created: mutation.created };
}

/**
 * 在同一事务里校验撤销生效线并返回服务端 canonical 状态。
 * card 必须传入确认卡生成时观察到的 revocationEpoch；旧卡不能越过后续撤销复活 grant。
 */
export async function createConfirmGrantCanonical(input: {
  kind: ConfirmGrantKind;
  source: ConfirmGrantSource;
  grantId?: string;
  now?: string;
  subjectId?: string;
  expectedRevocationEpoch?: number;
}): Promise<ConfirmGrantMutation> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const stateResult = await client.execute({
      sql: `SELECT version, revocation_epoch FROM confirm_grant_states WHERE kind = ?`,
      args: [input.kind],
    });
    const stateRow = stateResult.rows[0] as Record<string, unknown> | undefined;
    if (!stateRow) throw new Error(`confirm grant state missing for ${input.kind}`);
    const version = Number(stateRow.version);
    const revocationEpoch = Number(stateRow.revocation_epoch);
    const existing = await client.execute({
      sql: `SELECT grant_id, kind, created_at, source FROM confirm_grants WHERE kind = ?`,
      args: [input.kind],
    });
    const row = existing.rows[0] as Record<string, unknown> | undefined;
    const currentGrant = row ? mapGrant(row) : null;
    if (
      input.expectedRevocationEpoch !== undefined &&
      input.expectedRevocationEpoch !== revocationEpoch
    ) {
      return commitTransaction<ConfirmGrantMutation>({
        state: mapGrantState(input.kind, version, revocationEpoch, currentGrant),
        grant: null,
        created: false,
        stale: true,
      });
    }
    if (row) {
      return commitTransaction<ConfirmGrantMutation>({
        state: mapGrantState(input.kind, version, revocationEpoch, currentGrant),
        grant: currentGrant,
        created: false,
        stale: false,
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
    const nextVersion = version + 1;
    await client.execute({
      sql: `UPDATE confirm_grant_states SET version = ? WHERE kind = ?`,
      args: [nextVersion, input.kind],
    });
    return commitTransaction<ConfirmGrantMutation>({
      state: mapGrantState(input.kind, nextVersion, revocationEpoch, grant),
      grant,
      created: true,
      stale: false,
    });
  });
}

export async function revokeConfirmGrant(
  kind: ConfirmGrantKind,
  source: ConfirmGrantSource = "settings",
  now = new Date().toISOString(),
  subjectId = "local-user",
): Promise<ConfirmGrant | null> {
  return (await revokeConfirmGrantWithState(kind, source, now, subjectId)).revokedGrant;
}

/** 撤销意图即推进版本与撤销线；即使当前没有 grant，也能使更早生成的卡失效。 */
export async function revokeConfirmGrantWithState(
  kind: ConfirmGrantKind,
  source: ConfirmGrantSource = "settings",
  now = new Date().toISOString(),
  subjectId = "local-user",
): Promise<ConfirmGrantRevocation> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const stateResult = await client.execute({
      sql: `SELECT version, revocation_epoch FROM confirm_grant_states WHERE kind = ?`,
      args: [kind],
    });
    const stateRow = stateResult.rows[0] as Record<string, unknown> | undefined;
    if (!stateRow) throw new Error(`confirm grant state missing for ${kind}`);
    const nextVersion = Number(stateRow.version) + 1;
    const existing = await client.execute({
      sql: `SELECT grant_id, kind, created_at, source FROM confirm_grants WHERE kind = ?`,
      args: [kind],
    });
    const row = existing.rows[0] as Record<string, unknown> | undefined;
    const grant = row ? mapGrant(row) : null;
    if (grant) {
      await client.execute({ sql: `DELETE FROM confirm_grants WHERE kind = ?`, args: [kind] });
      await client.execute({
        sql: `INSERT INTO confirm_grant_events (
          event_id, ts, grant_id, kind, action, source, subject_id
        ) VALUES (?, ?, ?, ?, 'revoked', ?, ?)`,
        args: [randomUUID(), now, grant.grantId, grant.kind, source, subjectId],
      });
    }
    await client.execute({
      sql: `UPDATE confirm_grant_states
        SET version = ?, revocation_epoch = ?
        WHERE kind = ?`,
      args: [nextVersion, nextVersion, kind],
    });
    return commitTransaction<ConfirmGrantRevocation>({
      state: mapGrantState(kind, nextVersion, nextVersion, null),
      revokedGrant: grant,
    });
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
