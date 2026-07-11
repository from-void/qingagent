// 凭据存储:libsql 表 sandbox_credentials,值加密落库。
// 当前产品单用户,scope 固定 "default";多租户化时换成真实 userId。

import {
  commitTransaction,
  getDocumentsClient,
  withTransaction,
  withWriteRetry,
} from "../db/documentsClient.js";
import { ensureMigrated } from "../db/migrations.js";
import {
  decryptCredential,
  decryptCredentialWithKey,
  encryptCredential,
} from "./crypto.js";
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

export interface ConnectorCredentialBundle<T = unknown> {
  version: 1;
  connectorId: string;
  revision: number;
  payload: T;
}

export interface SaveConnectorBundleOptions {
  /** undefined=无条件新 revision；null=仅当不存在；number=仅当当前 revision 相等。 */
  expectedRevision?: number | null;
  scope?: string;
}

export class ConnectorCredentialCasError extends Error {
  readonly code = "CONNECTOR_CREDENTIAL_CAS_MISMATCH";
  readonly status = 409;

  constructor(
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null,
  ) {
    super(`连接器凭据 revision 冲突: expected=${expectedRevision}, actual=${actualRevision}`);
    this.name = "ConnectorCredentialCasError";
  }
}

const CONNECTOR_BUNDLE_KEY = "bundle";

function connectorBundlePlatform(connectorId: string): string {
  return `connector:${connectorId}`;
}

function parseConnectorBundle<T>(stored: string, connectorId: string): ConnectorCredentialBundle<T> {
  const plaintext = decryptCredential(stored);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (cause) {
    throw new Error(`连接器 ${connectorId} 凭据 bundle JSON 损坏`, { cause });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).version !== 1 ||
    (parsed as Record<string, unknown>).connectorId !== connectorId ||
    !Number.isInteger((parsed as Record<string, unknown>).revision) ||
    Number((parsed as Record<string, unknown>).revision) < 1 ||
    !("payload" in parsed)
  ) {
    throw new Error(`连接器 ${connectorId} 凭据 bundle 格式非法`);
  }
  return parsed as ConnectorCredentialBundle<T>;
}

async function readBundleRow<T>(
  client: Pick<ReturnType<typeof getDocumentsClient>, "execute">,
  connectorId: string,
  scope: string,
): Promise<ConnectorCredentialBundle<T> | null> {
  const result = await client.execute({
    sql: `SELECT value_enc FROM sandbox_credentials
          WHERE scope = ? AND platform = ? AND cred_key = ?`,
    args: [scope, connectorBundlePlatform(connectorId), CONNECTOR_BUNDLE_KEY],
  });
  const row = result.rows[0];
  return row ? parseConnectorBundle<T>(String(row.value_enc), connectorId) : null;
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

/** 同一事务原子批量写；任一加密或 SQL 失败均不会留下部分 key。 */
export async function saveCredentialRecordsBatch(
  inputs: readonly CredentialInput[],
  scope = DEFAULT_SCOPE,
): Promise<void> {
  if (inputs.length === 0) return;
  await ensureMigrated();
  const now = new Date().toISOString();
  const encrypted = inputs.map((input) => ({ input, valueEnc: encryptCredential(input.value) }));
  await withTransaction(async (client) => {
    for (const { input, valueEnc } of encrypted) {
      await client.execute({
        sql: `INSERT INTO sandbox_credentials (scope, platform, cred_key, value_enc, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(scope, platform, cred_key)
              DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
        args: [scope, input.platform, input.key, valueEnc, now, now],
      });
    }
    return commitTransaction(undefined);
  });
}

export async function getConnectorCredentialBundle<T = unknown>(
  connectorId: string,
  scope = DEFAULT_SCOPE,
): Promise<ConnectorCredentialBundle<T> | null> {
  await ensureMigrated();
  return readBundleRow<T>(getDocumentsClient(), connectorId, scope);
}

/** 单行 bundle 写入 + revision CAS；新 revision 在事务锁内计算。 */
export async function saveConnectorCredentialBundle<T>(
  connectorId: string,
  payload: T,
  options: SaveConnectorBundleOptions = {},
): Promise<ConnectorCredentialBundle<T>> {
  await ensureMigrated();
  const scope = options.scope ?? DEFAULT_SCOPE;
  return withTransaction(async (client) => {
    const current = await readBundleRow<T>(client, connectorId, scope);
    const actualRevision = current?.revision ?? null;
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== actualRevision
    ) {
      throw new ConnectorCredentialCasError(options.expectedRevision, actualRevision);
    }
    const bundle: ConnectorCredentialBundle<T> = {
      version: 1,
      connectorId,
      revision: (current?.revision ?? 0) + 1,
      payload,
    };
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO sandbox_credentials (scope, platform, cred_key, value_enc, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, platform, cred_key)
            DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
      args: [
        scope,
        connectorBundlePlatform(connectorId),
        CONNECTOR_BUNDLE_KEY,
        encryptCredential(JSON.stringify(bundle)),
        now,
        now,
      ],
    });
    return commitTransaction(bundle);
  });
}

export interface ReadThroughBundleMigrationOptions<T> {
  connectorId: string;
  legacyPlatform: string;
  legacyKeys: readonly string[];
  scope?: string;
  /** 在 BEGIN IMMEDIATE 内执行的同步纯转换；不得调用仓储、I/O 或返回 Promise。 */
  migrate: (legacy: Readonly<Record<string, string>>) => T;
}

export interface ReadThroughBundleMigrationResult<T> {
  bundle: ConnectorCredentialBundle<T> | null;
  migrated: boolean;
}

/**
 * 并发安全 read-through 原语：事务内先查 bundle；无则完整读取 legacy key 集并 INSERT
 * DO NOTHING；提交后再读胜者。迁移路径永不 UPDATE bundle，也不删除 legacy key。
 */
export async function readThroughMigrateConnectorBundle<T>(
  options: ReadThroughBundleMigrationOptions<T>,
): Promise<ReadThroughBundleMigrationResult<T>> {
  await ensureMigrated();
  const scope = options.scope ?? DEFAULT_SCOPE;
  if (options.legacyKeys.length === 0 || new Set(options.legacyKeys).size !== options.legacyKeys.length) {
    throw new Error("legacyKeys 必须是非空且不重复的 key 集");
  }

  const transactionResult = await withTransaction(async (client) => {
    const existing = await readBundleRow<T>(client, options.connectorId, scope);
    if (existing) return commitTransaction({ hadBundle: true, inserted: false });

    const placeholders = options.legacyKeys.map(() => "?").join(", ");
    const rows = await client.execute({
      sql: `SELECT cred_key, value_enc FROM sandbox_credentials
            WHERE scope = ? AND platform = ? AND cred_key IN (${placeholders})`,
      args: [scope, options.legacyPlatform, ...options.legacyKeys],
    });
    const encryptedByKey = new Map(
      rows.rows.map((row) => [String(row.cred_key), String(row.value_enc)]),
    );
    if (options.legacyKeys.some((key) => !encryptedByKey.has(key))) {
      return commitTransaction({ hadBundle: false, inserted: false });
    }

    const legacy: Record<string, string> = {};
    for (const key of options.legacyKeys) {
      // 单 key 损坏直接抛错并回滚；禁止用残缺集合生成看似成功的 bundle。
      legacy[key] = decryptCredential(encryptedByKey.get(key)!);
    }
    const payload = options.migrate(legacy);
    const bundle: ConnectorCredentialBundle<T> = {
      version: 1,
      connectorId: options.connectorId,
      revision: 1,
      payload,
    };
    const now = new Date().toISOString();
    const inserted = await client.execute({
      sql: `INSERT INTO sandbox_credentials (scope, platform, cred_key, value_enc, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, platform, cred_key) DO NOTHING`,
      args: [
        scope,
        connectorBundlePlatform(options.connectorId),
        CONNECTOR_BUNDLE_KEY,
        encryptCredential(JSON.stringify(bundle)),
        now,
        now,
      ],
    });
    return commitTransaction({ hadBundle: false, inserted: inserted.rowsAffected === 1 });
  });

  const winner = await getConnectorCredentialBundle<T>(options.connectorId, scope);
  return {
    bundle: winner,
    migrated: !transactionResult.hadBundle && transactionResult.inserted,
  };
}

export interface DeleteConnectorBundleOptions {
  expectedRevision: number;
  scope?: string;
}

/** disconnect 删除也必须 CAS，避免迟到请求删掉并发重连写入的新 revision。 */
export async function deleteConnectorCredentialBundle(
  connectorId: string,
  options: DeleteConnectorBundleOptions,
): Promise<void> {
  await ensureMigrated();
  const scope = options.scope ?? DEFAULT_SCOPE;
  await withTransaction(async (client) => {
    const current = await readBundleRow(client, connectorId, scope);
    const actualRevision = current?.revision ?? null;
    if (actualRevision !== options.expectedRevision) {
      throw new ConnectorCredentialCasError(options.expectedRevision, actualRevision);
    }
    await client.execute({
      sql: `DELETE FROM sandbox_credentials
            WHERE scope = ? AND platform = ? AND cred_key = ?`,
      args: [scope, connectorBundlePlatform(connectorId), CONNECTOR_BUNDLE_KEY],
    });
    return commitTransaction(undefined);
  });
}

/** desktop safeStorage 升级切换前验证库内全部既有密文，不依赖当前全局 provider。 */
export async function verifyStoredCredentialCiphertextsWithKey(key: Buffer): Promise<void> {
  await ensureMigrated();
  const result = await getDocumentsClient().execute(
    "SELECT value_enc FROM sandbox_credentials ORDER BY scope, platform, cred_key",
  );
  for (const row of result.rows) {
    decryptCredentialWithKey(String(row.value_enc), key);
  }
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
