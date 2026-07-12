import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";
import {
  ensurePragmas,
  getDocumentsClient,
  resolveDbUrl,
  withWriteRetry,
} from "./documentsClient.js";
import { MIGRATIONS } from "./migrations/index.js";
import type { Migration } from "./migrations/types.js";
export type { Migration } from "./migrations/types.js";

// ── 版本化 DB 迁移 runner（自写 ~150 行，不引 umzug/drizzle）──
// 语义:schema_migrations 账本 + id 严格连续 + 每条迁移 BEGIN IMMEDIATE 事务 +
// 贴合既有 withWriteRetry/ensurePragmas/BUSY 语义。单例 Promise ensureMigrated()
// 替代历史四个模块级 xxxReady 布尔（顺带修并发首调竞态）。
// 保持轻量自管迁移,避免为当前规模引入额外 migration framework。

export interface MigrationResult {
  /** 本次实际应用的迁移号(已按序);无未应用迁移时为空。 */
  appliedIds: number[];
  /** 迁移前是否生成了自动备份。 */
  backupPath: string | null;
}

const LEDGER_TABLE = "schema_migrations";

/** 注册表连续性断言:id 必须 1..N 连续(仿 pm-schema assertPmMigrationRegistryContinuous)。 */
export function assertMigrationsContinuous(migrations: readonly Migration[]): void {
  for (let i = 0; i < migrations.length; i += 1) {
    const expected = i + 1;
    const actual = migrations[i]?.id;
    if (actual !== expected) {
      throw new Error(
        `Migration registry is not continuous at index ${i}: expected id ${expected}, got ${actual}`,
      );
    }
  }
}

async function ensureLedger(client: Client): Promise<void> {
  await withWriteRetry(() =>
    client.execute(
      `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
        id          INTEGER PRIMARY KEY,
        name        TEXT    NOT NULL,
        applied_at  TEXT    NOT NULL
      )`,
    ),
  );
}

async function readAppliedMax(client: Client): Promise<number> {
  const res = await client.execute(`SELECT MAX(id) AS maxId FROM ${LEDGER_TABLE}`);
  const raw = res.rows[0]?.maxId;
  return raw == null ? 0 : Number(raw);
}

/**
 * 是否已存在应用自有表(排除账本、sqlite 内部、mastra_* 框架表)。
 * 用于判定"全新库 vs 既有库":全新库无需备份(无数据可保护),既有库升级前备份。
 */
async function hasPreExistingAppTables(client: Client): Promise<boolean> {
  const res = await client.execute(
    `SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'table'
        AND name != '${LEDGER_TABLE}'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE 'mastra_%'
        AND name NOT LIKE 'libsql_%'
        AND name NOT LIKE '_litestream%'`,
  );
  return Number(res.rows[0]?.n ?? 0) > 0;
}

// ── 迁移前自动备份:仅 file: 库、仅存在未应用迁移时 ──

const BACKUP_RETAIN = 3;

/** 解析 DATABASE_URL 为本地文件绝对路径;非 file: 库返回 null。 */
function resolveDbFilePath(): string | null {
  const url = resolveDbUrl();
  if (!url.startsWith("file:")) return null;
  const rest = url.slice("file:".length);
  // desktop 用 pathToFileURL().href → file:///abs/path 形态;server 用 file:./relative。
  if (rest.startsWith("//")) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  return path.resolve(rest);
}

function timestampForBackup(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * 迁移前备份:先 PRAGMA wal_checkpoint(TRUNCATE) 把 WAL 落盘,再连 -wal/-shm 一起拷为
 * `<db>.bak-pre-v{targetId}-{yyyyMMddHHmmss}`;保留最近 BACKUP_RETAIN 份,老的清掉。
 * 返回主备份文件路径(用于失败提示);任何异常向上抛(备份失败不应静默继续迁移)。
 */
async function backupBeforeMigrate(
  client: Client,
  dbFile: string,
  targetId: number,
  now: Date,
): Promise<string> {
  await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  const dir = path.dirname(dbFile);
  const base = path.basename(dbFile);
  const suffix = `bak-pre-v${targetId}-${timestampForBackup(now)}`;
  const backupPath = `${dbFile}.${suffix}`;
  copyFileSync(dbFile, backupPath);
  // WAL/SHM 若存在一并拷(TRUNCATE 后通常为空,拷贝无害,保证快照完整)。
  for (const ext of ["-wal", "-shm"]) {
    const side = `${dbFile}${ext}`;
    if (existsSync(side)) copyFileSync(side, `${backupPath}${ext}`);
  }
  pruneOldBackups(dir, base);
  return backupPath;
}

/** 只保留最近 BACKUP_RETAIN 份备份(按文件名内时间戳字典序),连同 -wal/-shm 一起删。 */
function pruneOldBackups(dir: string, base: string): void {
  const prefix = `${base}.bak-pre-v`;
  const mains = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && !f.endsWith("-wal") && !f.endsWith("-shm"))
    .sort(); // yyyyMMddHHmmss 字典序即时间序
  const stale = mains.slice(0, Math.max(0, mains.length - BACKUP_RETAIN));
  for (const name of stale) {
    for (const ext of ["", "-wal", "-shm"]) {
      const target = path.join(dir, `${name}${ext}`);
      if (existsSync(target)) rmSync(target, { force: true });
    }
  }
}

// ── 核心:运行迁移 ──

/**
 * 运行全部未应用迁移。启动前 await 调用(server index.ts / desktop server.ts),
 * 也被 repo 层单例 ensureMigrated() 复用。可注入 migrations 供测试。
 */
export async function runMigrations(
  migrations: readonly Migration[] = activeMigrations,
): Promise<MigrationResult> {
  assertMigrationsContinuous(migrations);
  const client = getDocumentsClient();
  await ensurePragmas(client);
  await ensureLedger(client);

  const appliedMax = await readAppliedMax(client);
  const pending = migrations.filter((m) => m.id > appliedMax);
  if (pending.length === 0) {
    return { appliedIds: [], backupPath: null };
  }

  // 备份:仅 file: 库、存在未应用迁移、且是"既有库"(有历史迁移记录或已存在应用表)。
  // 全新空库无数据可保护,跳过备份(避免首启就生成无意义 .bak)。
  let backupPath: string | null = null;
  const dbFile = resolveDbFilePath();
  if (dbFile && existsSync(dbFile)) {
    const nonFresh = appliedMax > 0 || (await hasPreExistingAppTables(client));
    if (nonFresh) {
      const targetId = pending[pending.length - 1]!.id;
      backupPath = await backupBeforeMigrate(client, dbFile, targetId, new Date());
    }
  }

  for (const m of pending) {
    // 每条迁移一个 BEGIN IMMEDIATE 事务;失败 ROLLBACK 并整体 fail。
    // 外层 withWriteRetry 吃 SQLITE_BUSY(重试前已 ROLLBACK,从干净态重跑)。
    await withWriteRetry(async () => {
      await client.execute("BEGIN IMMEDIATE");
      try {
        await m.up(client);
        await client.execute({
          sql: `INSERT INTO ${LEDGER_TABLE} (id, name, applied_at) VALUES (?, ?, ?)`,
          args: [m.id, m.name, new Date().toISOString()],
        });
        await client.execute("COMMIT");
      } catch (err) {
        try {
          await client.execute("ROLLBACK");
        } catch {
          // 原始错误更有价值;ROLLBACK 失败只说明事务已结束或连接异常。
        }
        throw err;
      }
    });
  }

  return { appliedIds: pending.map((m) => m.id), backupPath };
}

// ── 单例 Promise:替代历史四个 xxxReady 布尔,修并发首调竞态 ──

let migratedPromise: Promise<void> | null = null;
let activeMigrations: readonly Migration[] = MIGRATIONS;

/**
 * repo 层入口:进程内保证迁移只跑一次。多个并发首调共享同一 Promise。
 * 失败时清空缓存以允许下次重试(与旧 ensure* "失败不置 ready" 语义一致)。
 */
export function ensureMigrated(): Promise<void> {
  if (!migratedPromise) {
    migratedPromise = runMigrations()
      .then(() => undefined)
      .catch((err) => {
        migratedPromise = null;
        throw err;
      });
  }
  return migratedPromise;
}

/** 测试用:重置单例(配合临时库),对齐历史 __reset*ForTest 惯例。 */
export function __resetMigrationsForTest(): void {
  migratedPromise = null;
  activeMigrations = MIGRATIONS;
}

/** 测试用:注入自定义迁移集(并发/回滚等机制测试),配 __resetMigrationsForTest 复位。 */
export function __setMigrationsForTest(migrations: readonly Migration[]): void {
  activeMigrations = migrations;
}
