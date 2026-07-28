import { randomUUID } from "node:crypto";
import { commitTransaction, getDocumentsClient, withTransaction } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

/**
 * 命令行工具凭证共享授权。一条授权 = 一个规范化绝对路径,由某个技能声明并经用户确认。
 * 审计沿用 confirm_audit_events(kind='connect', subject_id=路径),安全页可逐条回收。
 */
export type CredentialGrantSource = "card" | "settings" | "preset";

export interface CredentialGrant {
  path: string;
  grantId: string;
  skillName: string;
  /** frontmatter 里的原始写法(~/...),用于回显给用户。 */
  declared: string;
  createdAt: string;
  source: CredentialGrantSource;
}

function mapGrant(row: Record<string, unknown>): CredentialGrant {
  return {
    path: String(row.path),
    grantId: String(row.grant_id),
    skillName: String(row.skill_name),
    declared: String(row.declared),
    createdAt: String(row.created_at),
    source: String(row.source) as CredentialGrantSource,
  };
}

type TransactionClient = Parameters<Parameters<typeof withTransaction>[0]>[0];

async function appendCredentialAudit(
  client: TransactionClient,
  input: { path: string; grantId: string; action: "created" | "revoked"; now: string },
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO confirm_audit_events (
      event_id, ts, event_type, subject_id, session_id, run_id, tool_call_id, confirm_id,
      kind, command_digest, command_preview, decision, source, grant_id,
      result, policy_version, isolation_epoch, config_hash
    ) VALUES (?, ?, ?, ?, 'settings', 'settings', 'settings', ?, 'connect', '', '',
      'accepted', 'settings', ?, ?, 'credential-passthrough-v1', NULL, NULL)`,
    args: [
      randomUUID(),
      input.now,
      input.action === "created" ? "grant_created" : "grant_revoked",
      input.path,
      `credential:${input.path}`,
      input.grantId,
      input.action === "created" ? "grant-created" : "grant-revoked",
    ],
  });
}

export async function listCredentialGrants(): Promise<CredentialGrant[]> {
  await ensureMigrated();
  const result = await getDocumentsClient().execute(
    `SELECT path, grant_id, skill_name, declared, created_at, source
      FROM credential_grants ORDER BY path`,
  );
  return result.rows.map((row) => mapGrant(row as Record<string, unknown>));
}

export async function listGrantedCredentialPaths(): Promise<string[]> {
  return (await listCredentialGrants()).map((grant) => grant.path);
}

export interface CredentialGrantMutation {
  grant: CredentialGrant;
  created: boolean;
}

/** 幂等:同一路径重复授权返回既有记录,created=false。 */
export async function createCredentialGrant(input: {
  path: string;
  skillName: string;
  declared: string;
  source: CredentialGrantSource;
  grantId?: string;
  now?: string;
}): Promise<CredentialGrantMutation> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const existing = await client.execute({
      sql: `SELECT path, grant_id, skill_name, declared, created_at, source
        FROM credential_grants WHERE path = ?`,
      args: [input.path],
    });
    const row = existing.rows[0] as Record<string, unknown> | undefined;
    if (row) {
      return commitTransaction<CredentialGrantMutation>({ grant: mapGrant(row), created: false });
    }
    const grant: CredentialGrant = {
      path: input.path,
      grantId: input.grantId ?? randomUUID(),
      skillName: input.skillName,
      declared: input.declared,
      createdAt: input.now ?? new Date().toISOString(),
      source: input.source,
    };
    await client.execute({
      sql: `INSERT INTO credential_grants (path, grant_id, skill_name, declared, created_at, source)
        VALUES (?, ?, ?, ?, ?, ?)`,
      args: [grant.path, grant.grantId, grant.skillName, grant.declared, grant.createdAt, grant.source],
    });
    await appendCredentialAudit(client, {
      path: grant.path,
      grantId: grant.grantId,
      action: "created",
      now: grant.createdAt,
    });
    return commitTransaction<CredentialGrantMutation>({ grant, created: true });
  });
}

/** 回收:返回被删除的授权;没有则返回 null。下次构建沙箱即失效。 */
export async function revokeCredentialGrant(
  path: string,
  now = new Date().toISOString(),
): Promise<CredentialGrant | null> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const existing = await client.execute({
      sql: `SELECT path, grant_id, skill_name, declared, created_at, source
        FROM credential_grants WHERE path = ?`,
      args: [path],
    });
    const row = existing.rows[0] as Record<string, unknown> | undefined;
    if (!row) return commitTransaction<CredentialGrant | null>(null);
    const grant = mapGrant(row);
    await client.execute({ sql: `DELETE FROM credential_grants WHERE path = ?`, args: [path] });
    await appendCredentialAudit(client, {
      path: grant.path,
      grantId: grant.grantId,
      action: "revoked",
      now,
    });
    return commitTransaction<CredentialGrant | null>(grant);
  });
}
