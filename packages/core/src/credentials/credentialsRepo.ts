// 凭据存储:libsql 表 sandbox_credentials,值加密落库。
// 当前产品单用户,scope 固定 "default";多租户化时换成真实 userId。

import { getDocumentsClient, withWriteRetry } from "../db/documentsClient.js";
import { ensureMigrated } from "../db/migrations.js";
import { decryptCredential, encryptCredential } from "./crypto.js";
import { PLATFORM_CREDENTIAL_SPECS } from "./specs.js";

const DEFAULT_SCOPE = "default";

function registeredCredentialKeysByPlatform(): Map<string, Set<string>> {
  return new Map(
    PLATFORM_CREDENTIAL_SPECS.map((spec) => [
      spec.platform,
      new Set(spec.fields.map((field) => field.key)),
    ]),
  );
}

export interface CredentialInput {
  platform: string;
  key: string;
  value: string;
}

/** 写入/更新一条凭据(值加密)。 */
export async function saveCredentialRecord(
  input: CredentialInput,
  scope = DEFAULT_SCOPE,
): Promise<void> {
  await ensureMigrated();
  const now = new Date().toISOString();
  const valueEnc = encryptCredential(input.value);
  const client = getDocumentsClient();
  await withWriteRetry(async () => {
    await client.execute({
      sql: `INSERT INTO sandbox_credentials (scope, platform, cred_key, value_enc, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, platform, cred_key)
            DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
      args: [scope, input.platform, input.key, valueEnc, now, now],
    });
  });
}

/** 读取某平台的全部凭据(解密)。损坏的条目跳过(不让一条坏值毁掉整组注入)。 */
export async function getCredentialsForPlatform(
  platform: string,
  scope = DEFAULT_SCOPE,
): Promise<Record<string, string>> {
  await ensureMigrated();
  const client = getDocumentsClient();
  const res = await client.execute({
    sql: `SELECT cred_key, value_enc FROM sandbox_credentials WHERE scope = ? AND platform = ?`,
    args: [scope, platform],
  });
  const out: Record<string, string> = {};
  for (const row of res.rows) {
    const key = String(row.cred_key);
    try {
      out[key] = decryptCredential(String(row.value_enc));
    } catch {
      // 密钥轮换/损坏:跳过该条
    }
  }
  return out;
}

/** 读取所有平台凭据,扁平成 env 注入用的 key→value(cred_key 即 env 键名)。 */
export async function getAllCredentialEnv(scope = DEFAULT_SCOPE): Promise<Record<string, string>> {
  await ensureMigrated();
  const client = getDocumentsClient();
  const res = await client.execute({
    sql: `SELECT platform, cred_key, value_enc FROM sandbox_credentials WHERE scope = ?`,
    args: [scope],
  });
  const allowedKeysByPlatform = registeredCredentialKeysByPlatform();
  const out: Record<string, string> = {};
  for (const row of res.rows) {
    const platform = String(row.platform);
    const key = String(row.cred_key);
    const allowedKeys = allowedKeysByPlatform.get(platform);
    if (!allowedKeys?.has(key)) continue;
    try {
      out[key] = decryptCredential(String(row.value_enc));
    } catch {
      // 跳过损坏条目
    }
  }
  return out;
}

export interface CredentialMeta {
  platform: string;
  key: string;
  updatedAt: string;
  /** ok=可正常解密注入;invalid=密文解不开(密钥轮换/损坏),需重新配置。 */
  status: "ok" | "invalid";
}

/** 列出已配置的凭据元信息(不含明文,供 UI/回执展示)。尝试解密以标 ok/invalid,
 *  避免"显示已配置但脚本报缺凭据"的不一致。 */
export async function listCredentialMeta(scope = DEFAULT_SCOPE): Promise<CredentialMeta[]> {
  await ensureMigrated();
  const client = getDocumentsClient();
  const res = await client.execute({
    sql: `SELECT platform, cred_key, value_enc, updated_at FROM sandbox_credentials WHERE scope = ? ORDER BY platform, cred_key`,
    args: [scope],
  });
  const allowedKeysByPlatform = registeredCredentialKeysByPlatform();
  return res.rows.flatMap((row) => {
    const platform = String(row.platform);
    const key = String(row.cred_key);
    const allowedKeys = allowedKeysByPlatform.get(platform);
    if (!allowedKeys?.has(key)) return [];
    let status: "ok" | "invalid" = "ok";
    try {
      decryptCredential(String(row.value_enc));
    } catch {
      status = "invalid";
    }
    return {
      platform,
      key,
      updatedAt: String(row.updated_at),
      status,
    };
  });
}

/** 删除一条或一个平台的凭据。 */
export async function deleteCredential(
  platform: string,
  key?: string,
  scope = DEFAULT_SCOPE,
): Promise<void> {
  await ensureMigrated();
  const client = getDocumentsClient();
  await withWriteRetry(async () => {
    if (key) {
      await client.execute({
        sql: `DELETE FROM sandbox_credentials WHERE scope = ? AND platform = ? AND cred_key = ?`,
        args: [scope, platform, key],
      });
    } else {
      await client.execute({
        sql: `DELETE FROM sandbox_credentials WHERE scope = ? AND platform = ?`,
        args: [scope, platform],
      });
    }
  });
}
