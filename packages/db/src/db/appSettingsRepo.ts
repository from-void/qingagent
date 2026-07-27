// F1 全局设置存储(key-value):目前存全局兜底 DeepSeek key 与采样参数覆盖。
// 注意:visitor 层 key 永不落服务端,只有 global-db 层存这里。
// 读路径(设置 GET / 注入 RequestContext)绝不把明文 key 回传给前端。

import {
  commitTransaction,
  getDocumentsClient,
  withTransaction,
  withWriteRetry,
} from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

export async function getAppSetting(key: string): Promise<string | null> {
  const client = getDocumentsClient();
  await ensureMigrated();
  const result = await client.execute({
    sql: `SELECT value FROM app_settings WHERE key = ?`,
    args: [key],
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? String(row.value) : null;
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  const client = getDocumentsClient();
  await ensureMigrated();
  await withWriteRetry(() =>
    client.execute({
      sql: `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [key, value, new Date().toISOString()],
    }),
  );
}

export async function setAppSettingJsonField(
  key: string,
  field: string,
  value: unknown,
): Promise<void> {
  await ensureMigrated();
  await withTransaction(async (client) => {
    const result = await client.execute({
      sql: `SELECT value FROM app_settings WHERE key = ?`,
      args: [key],
    });
    const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
    const current = parseJsonObject(row ? String(row.value) : null);
    current[field] = value;
    await client.execute({
      sql: `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [key, JSON.stringify(current), new Date().toISOString()],
    });
    return commitTransaction(undefined);
  });
}

export async function patchAppSettingJsonField(
  key: string,
  field: string,
  patch: Readonly<Record<string, unknown>>,
  deleteFields: readonly string[] = [],
): Promise<void> {
  await ensureMigrated();
  await withTransaction(async (client) => {
    const result = await client.execute({
      sql: `SELECT value FROM app_settings WHERE key = ?`,
      args: [key],
    });
    const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
    const root = parseJsonObject(row ? String(row.value) : null);
    const currentField = parseJsonObjectValue(root[field]);
    Object.assign(currentField, patch);
    for (const name of deleteFields) delete currentField[name];
    root[field] = currentField;
    await client.execute({
      sql: `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [key, JSON.stringify(root), new Date().toISOString()],
    });
    return commitTransaction(undefined);
  });
}

export async function deleteAppSetting(key: string): Promise<void> {
  const client = getDocumentsClient();
  await ensureMigrated();
  await withWriteRetry(() =>
    client.execute({ sql: `DELETE FROM app_settings WHERE key = ?`, args: [key] }),
  );
}

export const SETTING_DEEPSEEK_GLOBAL_KEY = "deepseek_global_api_key";
export const SETTING_KIMI_GLOBAL_KEY = "kimi_global_api_key";
export const SETTING_MODEL_PROVIDER = "model_provider";
export const SETTING_MODEL_PARAMS = "model_param_overrides";
export const SETTING_SEARCH_PROVIDER_CONFIG = "search_provider_config";
export const SETTING_SEARCH_PRIMARY = "search_primary";

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  } catch {
    return {};
  }
}

function parseJsonObjectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
