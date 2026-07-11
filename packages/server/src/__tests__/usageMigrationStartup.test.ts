import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "../../../core/src/db/__tests__/dbTestUtils.js";
import { getDocumentsClient } from "../../../core/src/db/documentsClient.js";
import { __resetMigrationsForTest, runMigrations } from "../../../core/src/db/migrations.js";
import { MIGRATIONS } from "../../../core/src/db/migrations/index.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qingagent-server-usage-upgrade-"); });
afterEach(() => db.cleanup());

describe("旧 DB → server 重启迁移", () => {
  it("server 启动先迁移再加载 app，v2 usage 行升级后保真", async () => {
    const source = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
    expect(source.indexOf("await runMigrations()"))
      .toBeLessThan(source.indexOf('await import("./app")'));

    await runMigrations(MIGRATIONS.slice(0, 2));
    const client = getDocumentsClient();
    await client.execute(
      `INSERT INTO llm_usage_events
       (id, session_id, call_site, model_id, key_origin, input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens, created_at)
       VALUES ('server-old', 'session-old', 'agent', 'deepseek-v4-flash', 'env', 9, 3, 4, 5, '2026-01-01T00:00:00.000Z')`,
    );
    __resetMigrationsForTest();

    expect((await runMigrations()).appliedIds).toEqual([3, 4]);
    const row = (await client.execute("SELECT * FROM llm_usage_events WHERE id = 'server-old'")).rows[0];
    expect(Number(row?.input_tokens)).toBe(9);
    expect(String(row?.usage_state)).toBe("recorded");
    expect(row?.lane).toBeNull();
    expect(row?.attempt).toBeNull();
    expect(row?.cache_accounting_state).toBe("unknown");
  });
});
