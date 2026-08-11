// 客户端首启 seed v2：把产品真实跑出的会话 fixture 整行搬入本地库。
//
// 关键约束：
//   · 本模块只负责幂等导入；桌面主进程用版本化标记文件控制 once 门。
//   · fixture 的数据库列动态读取，不复制 schema；固定主键配合 INSERT OR REPLACE 保证幂等。
//   · 只改数据库时间列，不解码或改写 metadata 等 BLOB 内部内容。
//   · 示例固定落在 2025-04-16 附近，避免污染「近 7 天文档 / 用量」统计。

import { cp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureMigrated,
  getDocumentsClient,
  setAppSetting,
} from "@qingagent/db";

type FixtureScalar = string | number | boolean | null;
type FixtureBlob = { __b64__: string };
type FixtureValue = FixtureScalar | FixtureBlob;
type FixtureRow = Record<string, FixtureValue>;

interface SeedFixture {
  piece: string;
  sessionId: string;
  threads: FixtureRow[];
  documents: FixtureRow[];
  derivatives: FixtureRow[];
  sessionResources: FixtureRow[];
  assetFileIds: string[];
}

interface FixtureManifest {
  order: string[];
}

type FixtureBriefings = Record<string, string> & { _common: string };

export interface SeedInitialContentOptions {
  /** 测试或诊断时覆盖 fixture 根目录；生产默认自动解析源码/桌面资源目录。 */
  fixturesDir?: string;
}

const SEED_BASE_TS = Date.parse("2025-04-16T09:00:00+08:00");
const PIECE_OFFSET_MS = 6 * 60 * 1000;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const THREAD_TIME_COLUMNS = new Set(["createdAt", "updatedAt"]);
const DOCUMENT_TIME_COLUMNS = new Set(["created_at", "updated_at"]);
const DERIVATIVE_TIME_COLUMNS = new Set(["generated_at", "created_at", "updated_at"]);
const SESSION_RESOURCE_TIME_COLUMNS = new Set(["created_at", "updated_at"]);
const SOURCE_FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));

function resolvePackagedFixturesDir(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath;
  return typeof resourcesPath === "string" && resourcesPath.trim()
    ? resolve(resourcesPath, "seed-fixtures")
    : null;
}

function resolveFixturesDir(override?: string): string {
  if (override?.trim()) return resolve(override);
  const packaged = resolvePackagedFixturesDir();
  if (packaged && existsSync(packaged)) return packaged;
  return SOURCE_FIXTURES_DIR;
}

function resolveUploadsDir(): string {
  const configured = process.env.QINGAGENT_UPLOADS_DIR?.trim();
  // 与 packages/server/src/lib/uploadStorage.ts 的 UPLOAD_DIR 解析口径必须保持同步；
  // core 不 import server，避免形成反向包依赖。
  return configured ? resolve(configured) : resolve("./uploads");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function assertIdentifier(identifier: string): void {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`Seed fixture contains an invalid SQL identifier: ${identifier}`);
  }
}

function decodeFixtureValue(value: FixtureValue): string | number | null | Uint8Array {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (
    typeof value === "object"
    && Object.keys(value).length === 1
    && typeof value.__b64__ === "string"
  ) {
    return Buffer.from(value.__b64__, "base64");
  }
  throw new Error("Seed fixture contains an unsupported database value");
}

function rewriteRowTime(
  row: FixtureRow,
  columns: ReadonlySet<string>,
  timestamp: string,
): FixtureRow {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      columns.has(column) ? timestamp : value,
    ]),
  );
}

async function upsertRows(
  table:
    | "mastra_threads"
    | "documents"
    | "document_derivatives"
    | "session_resources",
  rows: readonly FixtureRow[],
): Promise<void> {
  assertIdentifier(table);
  const client = getDocumentsClient();
  for (const row of rows) {
    const columns = Object.keys(row);
    if (columns.length === 0) throw new Error(`Seed fixture has an empty ${table} row`);
    for (const column of columns) assertIdentifier(column);
    await client.execute({
      sql: `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      args: columns.map((column) => decodeFixtureValue(row[column]!)),
    });
  }
}

function composeBriefing(briefings: FixtureBriefings, piece: string): string {
  const common = briefings._common?.trim();
  const perPiece = briefings[piece]?.trim();
  if (!common || !perPiece) {
    throw new Error(`Seed fixture briefing is missing for piece: ${piece}`);
  }
  return `${common}\n\n${perPiece}`;
}

async function copyFixtureAssets(
  fixturesDir: string,
  uploadsDir: string,
  assetFileIds: readonly string[],
): Promise<void> {
  for (const fileId of assetFileIds) {
    if (!fileId || fileId === "." || fileId === ".." || /[\\/]/.test(fileId)) {
      throw new Error(`Seed fixture contains an invalid asset file id: ${fileId}`);
    }
    await cp(
      resolve(fixturesDir, "assets", fileId),
      resolve(uploadsDir, fileId),
      { recursive: true, force: true },
    );
  }
}

async function loadFixtures(fixturesDir: string): Promise<{
  manifest: FixtureManifest;
  briefings: FixtureBriefings;
  fixtures: SeedFixture[];
}> {
  const [manifest, briefings] = await Promise.all([
    readJson<FixtureManifest>(resolve(fixturesDir, "manifest.json")),
    readJson<FixtureBriefings>(resolve(fixturesDir, "briefings.json")),
  ]);
  if (!Array.isArray(manifest.order) || manifest.order.length === 0) {
    throw new Error("Seed fixture manifest.order must be a non-empty array");
  }
  const fixtures = await Promise.all(
    manifest.order.map((piece) =>
      readJson<SeedFixture>(resolve(fixturesDir, `${piece}.json`)),
    ),
  );
  fixtures.forEach((fixture, index) => {
    const expectedPiece = manifest.order[index];
    if (fixture.piece !== expectedPiece || !fixture.sessionId) {
      throw new Error(`Seed fixture identity mismatch for piece: ${expectedPiece}`);
    }
  });
  return { manifest, briefings, fixtures };
}

/**
 * 往本地库搬入真实示例会话。固定 id + INSERT OR REPLACE，因此重复执行不会增加行数。
 * once 门由桌面主进程维护；读取/导入失败时抛错，让桌面端保留“下次启动重试”语义。
 */
export async function seedInitialContent(
  options: SeedInitialContentOptions = {},
): Promise<void> {
  const fixturesDir = resolveFixturesDir(options.fixturesDir);
  const uploadsDir = resolveUploadsDir();
  // 先完整读取并校验清单，避免缺少中间 piece 时只落下一半数据。
  const { manifest, briefings, fixtures } = await loadFixtures(fixturesDir);

  await ensureMigrated();
  for (const [index, fixture] of fixtures.entries()) {
    const timestamp = new Date(SEED_BASE_TS - index * PIECE_OFFSET_MS).toISOString();
    await upsertRows(
      "mastra_threads",
      fixture.threads.map((row) => rewriteRowTime(row, THREAD_TIME_COLUMNS, timestamp)),
    );
    await upsertRows(
      "documents",
      fixture.documents.map((row) => rewriteRowTime(row, DOCUMENT_TIME_COLUMNS, timestamp)),
    );
    await upsertRows(
      "document_derivatives",
      fixture.derivatives.map((row) =>
        rewriteRowTime(row, DERIVATIVE_TIME_COLUMNS, timestamp)
      ),
    );
    await upsertRows(
      "session_resources",
      fixture.sessionResources.map((row) =>
        rewriteRowTime(row, SESSION_RESOURCE_TIME_COLUMNS, timestamp)
      ),
    );
    await copyFixtureAssets(fixturesDir, uploadsDir, fixture.assetFileIds);
    await setAppSetting(
      `seed_briefing:${fixture.sessionId}`,
      composeBriefing(briefings, manifest.order[index]!),
    );
  }
}
