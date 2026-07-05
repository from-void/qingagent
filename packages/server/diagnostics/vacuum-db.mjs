#!/usr/bin/env node
/**
 * vacuum-db.mjs — 回收 qingagent.db 的死页（dead pages）。
 *
 * ⚠️ 必须在后端（产品 server，:8080）停止时运行。
 *   后端通过 LibSQL 以 WAL 模式持有 qingagent.db。VACUUM 需要对整库加排他锁，
 *   后端在跑时会与之冲突（被阻塞 / 报 SQLITE_BUSY / 极端情况下损坏）。
 *   本脚本不会去 kill 后端；运行前请先手动停止后端，运行后再启动。
 *
 * 安全特性：
 *   - 运行前 `PRAGMA integrity_check` + 关键表行数做基线，VACUUM 后复核行数不变。
 *   - integrity 非 "ok" 直接中止，不做 VACUUM。
 *   - 默认 dry-run；真正改库需带 `--apply`，避免误操作。
 *
 * 用法（后端已停止时）：
 *   node packages/server/diagnostics/vacuum-db.mjs            # 只报告大小/行数/页使用，不改库
 *   node packages/server/diagnostics/vacuum-db.mjs --apply    # 实际 checkpoint + VACUUM + 再 checkpoint
 *
 * 实测说明（2026-05-31，对 packages/server/qingagent.db 的 /tmp 副本验证）：
 *   该库 166.6MB 中 ~162.5MB 是 mastra_workflow_snapshot 表的【活跃页】（freelist_count=0），
 *   真实会话 metadata 仅 ~3.3MB。换言之这不是「死页」，VACUUM 只能压回 ~166.4MB（几乎无效）。
 *   想真正瘦身需清理 mastra_workflow_snapshot 中陈旧的 askUser 工作流快照（业务删除，非 VACUUM）。
 *   本脚本保留 checkpoint+VACUUM 能力以回收【真出现】死页的场景。
 */
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// @libsql/client 不是 server 包的直接依赖（server 用 @mastra/libsql），只在 pnpm store 里，
// 无法用裸 import 解析。这里按 store 内 ESM 入口（lib-esm/node.js）的绝对路径动态导入。
// 若 pnpm 升级该依赖，更新下面的版本号目录即可。
const LIBSQL_ESM = resolve(
  __dirname,
  "../../../node_modules/.pnpm/@libsql+client@0.15.15/node_modules/@libsql/client/lib-esm/node.js",
);
const { createClient } = await import(LIBSQL_ESM);

// 默认目标：packages/server/qingagent.db（diagnostics/ 的上一级）。可传绝对路径覆盖。
const DB_PATH = process.argv[2] && !process.argv[2].startsWith("--")
  ? resolve(process.argv[2])
  : join(__dirname, "..", "qingagent.db");
const APPLY = process.argv.includes("--apply");

const mb = (bytes) => (bytes / 1048576).toFixed(2) + "MB";

if (!existsSync(DB_PATH)) {
  console.error(`[vacuum-db] qingagent.db not found at ${DB_PATH}`);
  process.exit(2);
}

const beforeMain = statSync(DB_PATH).size;
const beforeWal = existsSync(DB_PATH + "-wal") ? statSync(DB_PATH + "-wal").size : 0;
console.log(`[vacuum-db] target: ${DB_PATH}`);
console.log(`[vacuum-db] before: main=${mb(beforeMain)} wal=${mb(beforeWal)}`);

const client = createClient({ url: "file:" + DB_PATH });
const scalar = async (sql) => {
  const r = await client.execute(sql);
  return r.rows[0] ? Object.values(r.rows[0])[0] : null;
};

// 完整性自检
const integrity = await scalar("PRAGMA integrity_check");
console.log(`[vacuum-db] integrity_check: ${integrity}`);
if (String(integrity) !== "ok") {
  console.error("[vacuum-db] integrity_check failed — aborting, no VACUUM performed.");
  await client.close();
  process.exit(3);
}

// 页使用诊断：区分「真死页」（freelist 高）与「活跃页占满」（freelist≈0 时 VACUUM 无效）
const pageCount = await scalar("PRAGMA page_count");
const freelist = await scalar("PRAGMA freelist_count");
console.log(`[vacuum-db] page_count=${pageCount} freelist_count=${freelist} (freelist≈0 表示几乎无死页，VACUUM 收益有限)`);

// 关键表行数基线
const tbls = await client.execute(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
);
const rowsBefore = {};
for (const row of tbls.rows) {
  const t = row.name;
  try {
    rowsBefore[t] = String(await scalar(`SELECT count(*) FROM "${t}"`));
  } catch (e) {
    rowsBefore[t] = "ERR:" + String(e).slice(0, 40);
  }
}
console.log(`[vacuum-db] rowcounts before: ${JSON.stringify(rowsBefore)}`);

if (!APPLY) {
  console.log("[vacuum-db] DRY-RUN (no --apply): not modifying the database.");
  console.log("[vacuum-db] re-run with --apply (backend stopped) to actually reclaim.");
  await client.close();
  process.exit(0);
}

// 实际执行：checkpoint(TRUNCATE) → VACUUM → 再 checkpoint(TRUNCATE)。
// 关键：WAL 模式下 VACUUM 把重建后的库写进 WAL，主 .db 文件此刻还不缩，必须在 VACUUM
// 之后再 checkpoint(TRUNCATE) 把 WAL 折回主库并截断，文件才真正缩小（否则看似成功但体积不变）。
const cpPre = await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
console.log(`[vacuum-db] wal_checkpoint(TRUNCATE) pre: ${JSON.stringify(cpPre.rows)}`);
await client.execute("VACUUM");
console.log("[vacuum-db] VACUUM done");
const cpPost = await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
console.log(`[vacuum-db] wal_checkpoint(TRUNCATE) post: ${JSON.stringify(cpPost.rows)}`);
await client.close();

// 复核
const afterMain = statSync(DB_PATH).size;
const afterWal = existsSync(DB_PATH + "-wal") ? statSync(DB_PATH + "-wal").size : 0;
const client2 = createClient({ url: "file:" + DB_PATH });
const rowsAfter = {};
for (const row of tbls.rows) {
  const t = row.name;
  try {
    const r = await client2.execute(`SELECT count(*) FROM "${t}"`);
    rowsAfter[t] = String(r.rows[0] ? Object.values(r.rows[0])[0] : null);
  } catch {
    rowsAfter[t] = "ERR";
  }
}
await client2.close();

const unchanged = JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter);
console.log(`[vacuum-db] after: main=${mb(afterMain)} wal=${mb(afterWal)}`);
console.log(`[vacuum-db] rowcounts after: ${JSON.stringify(rowsAfter)}`);
console.log(`[vacuum-db] rowcounts unchanged: ${unchanged}`);
console.log(`[vacuum-db] RESULT: ${mb(beforeMain)} -> ${mb(afterMain)} (rowcounts preserved=${unchanged})`);

if (!unchanged) {
  console.error("[vacuum-db] WARNING: rowcounts changed after VACUUM — investigate!");
  process.exit(4);
}
process.exit(0);
