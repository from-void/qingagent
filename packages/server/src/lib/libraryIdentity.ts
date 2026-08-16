import { randomUUID } from "node:crypto";
import {
  ensureMigrated,
  getDocumentsClient,
  withWriteRetry,
  type Client,
} from "@qingagent/db";
import { isValidLibraryId } from "./libraryId";

export const LIBRARY_ID_SETTING_KEY = "library_id.v1";
export { isValidLibraryId } from "./libraryId";

/**
 * libraryId 随数据库持久化。INSERT OR IGNORE 让并发首启最终只采用一个值；读取到
 * 非法既有值时 fail closed，绝不静默换库身份。
 */
export async function getOrCreateLibraryId(options: {
  candidate?: string;
  client?: Client;
  skipMigration?: boolean;
} = {}): Promise<string> {
  const candidate = options.candidate ?? randomUUID();
  if (!isValidLibraryId(candidate)) throw new Error("invalid libraryId candidate");
  if (!options.skipMigration) await ensureMigrated();
  const client = options.client ?? getDocumentsClient();
  await withWriteRetry(() => client.execute({
    sql: `INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`,
    args: [LIBRARY_ID_SETTING_KEY, candidate, new Date().toISOString()],
  }));
  const result = await client.execute({
    sql: `SELECT value FROM app_settings WHERE key = ?`,
    args: [LIBRARY_ID_SETTING_KEY],
  });
  const value = result.rows[0]?.value;
  if (typeof value !== "string" || !isValidLibraryId(value)) {
    throw new Error("libraryId missing or malformed");
  }
  return value;
}
