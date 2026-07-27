import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { getDocumentsClient } from "../documentsClient.js";
import {
  __resetMigrationsForTest,
  assertMigrationsContinuous,
  ensureMigrated,
  runMigrations,
  type Migration,
} from "../migrations.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

// runner 内核行为锁:连续性断言 / 账本记账 / BEGIN IMMEDIATE 回滚 / 并发单次 / 备份。
// fixture 矩阵(五形态库等价性)在 migrationsFixtures.test.ts。

let db: TempDocumentsDb;

beforeEach(() => {
  db = prepareTempDocumentsDb("qa-migrations-runner-");
});

afterEach(() => {
  db.cleanup();
});

async function ledgerIds(client: Client): Promise<number[]> {
  const res = await client.execute("SELECT id FROM schema_migrations ORDER BY id");
  return res.rows.map((r) => Number(r.id));
}

async function seedLedger(
  rows: Array<{ id: number; name: string }>,
  options: { primaryKey?: boolean } = {},
): Promise<void> {
  const client = getDocumentsClient();
  await client.execute(
    `CREATE TABLE schema_migrations (
      id INTEGER ${options.primaryKey === false ? "" : "PRIMARY KEY"},
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  );
  for (const row of rows) {
    await client.execute({
      sql: "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)",
      args: [row.id, row.name, "2026-01-01T00:00:00.000Z"],
    });
  }
}

describe("assertMigrationsContinuous", () => {
  it("接受从 1 连续的注册表", () => {
    expect(() =>
      assertMigrationsContinuous([
        { id: 1, name: "a", up: async () => {} },
        { id: 2, name: "b", up: async () => {} },
      ]),
    ).not.toThrow();
  });

  it("拒绝跳号/乱序注册表", () => {
    expect(() =>
      assertMigrationsContinuous([
        { id: 1, name: "a", up: async () => {} },
        { id: 3, name: "c", up: async () => {} },
      ]),
    ).toThrow(/not continuous/i);
    expect(() =>
      assertMigrationsContinuous([{ id: 2, name: "b", up: async () => {} }]),
    ).toThrow(/not continuous/i);
  });
});

describe("runMigrations 记账与幂等", () => {
  it("按序应用未应用迁移并写账本", async () => {
    const applied: number[] = [];
    const migrations: Migration[] = [
      { id: 1, name: "one", up: async () => void applied.push(1) },
      { id: 2, name: "two", up: async () => void applied.push(2) },
    ];
    const r1 = await runMigrations(migrations);
    expect(r1.appliedIds).toEqual([1, 2]);
    expect(applied).toEqual([1, 2]);
    expect(await ledgerIds(getDocumentsClient())).toEqual([1, 2]);

    // 重复跑:无未应用迁移,不再执行 up。
    const r2 = await runMigrations(migrations);
    expect(r2.appliedIds).toEqual([]);
    expect(applied).toEqual([1, 2]);
  });

  it("合法连续账本只应用未记账的连续尾段", async () => {
    await runMigrations([{ id: 1, name: "one", up: async () => {} }]);
    const ran: number[] = [];
    const r = await runMigrations([
      { id: 1, name: "one", up: async () => void ran.push(1) },
      { id: 2, name: "two", up: async () => void ran.push(2) },
    ]);
    expect(r.appliedIds).toEqual([2]);
    expect(ran).toEqual([2]); // id=1 不重跑
  });
});

describe("迁移账本完整性 fail-stop", () => {
  const migrations: Migration[] = [
    { id: 1, name: "one", up: async () => {} },
    { id: 2, name: "two", up: async () => {} },
    { id: 3, name: "three", up: async () => {} },
  ];

  it("拒绝中间空洞，且不执行后续迁移或生成备份", async () => {
    await seedLedger([
      { id: 1, name: "one" },
      { id: 3, name: "three" },
    ]);
    let ran = false;
    const registry = migrations.map((migration) => ({
      ...migration,
      up: async () => {
        ran = true;
      },
    }));

    await expect(runMigrations(registry)).rejects.toThrow(/id 有空洞.*期望 id=2.*实际为 id=3/);
    expect(ran).toBe(false);
    expect(readdirSync(db.tempDir).some((name) => name.includes(".bak-pre-v"))).toBe(false);
  });

  it("拒绝重复 id，即使账本表被手工改成无主键", async () => {
    await seedLedger([
      { id: 1, name: "one" },
      { id: 1, name: "one" },
    ], { primaryKey: false });

    await expect(runMigrations(migrations)).rejects.toThrow(/重复迁移 id=1/);
  });

  it("拒绝同 id 的 name 漂移", async () => {
    await seedLedger([
      { id: 1, name: "renamed" },
    ]);

    await expect(runMigrations(migrations)).rejects.toThrow(
      /id=1 的 name 不匹配.*期望 "one".*实际为 "renamed"/,
    );
  });

  it("拒绝未来 id，并给出升级应用或还原备份指引", async () => {
    await seedLedger([
      { id: 1, name: "one" },
      { id: 2, name: "two" },
      { id: 3, name: "three" },
    ]);

    await expect(runMigrations(migrations.slice(0, 2))).rejects.toThrow(
      /未来迁移 id=3.*数据库来自更新版本，请升级应用或还原备份/,
    );
  });
});

describe("BEGIN IMMEDIATE 事务回滚", () => {
  it("迁移抛错则整体回滚:账本未推进、其变更未落地,修复后可重跑恢复", async () => {
    const client = getDocumentsClient();
    let shouldThrow = true;
    const migrations: Migration[] = [
      {
        id: 1,
        name: "create_probe",
        up: async (c) => {
          await c.execute("CREATE TABLE probe (v TEXT)");
        },
      },
      {
        id: 2,
        name: "flaky",
        up: async (c) => {
          await c.execute("INSERT INTO probe (v) VALUES ('x')");
          if (shouldThrow) throw new Error("boom");
        },
      },
    ];

    await expect(runMigrations(migrations)).rejects.toThrow(/boom/);
    // id=1 已提交,id=2 回滚:账本只有 1;probe 表存在但无 id=2 插入的行。
    expect(await ledgerIds(client)).toEqual([1]);
    const probe = await client.execute("SELECT COUNT(*) AS n FROM probe");
    expect(Number(probe.rows[0]?.n)).toBe(0);

    // 修复后重跑:从 id=2 继续,恢复到目标态。
    shouldThrow = false;
    const r = await runMigrations(migrations);
    expect(r.appliedIds).toEqual([2]);
    expect(await ledgerIds(client)).toEqual([1, 2]);
    const probe2 = await client.execute("SELECT COUNT(*) AS n FROM probe");
    expect(Number(probe2.rows[0]?.n)).toBe(1);
  });
});

describe("ensureMigrated 并发单次", () => {
  it("两个并发首调只执行一次迁移", async () => {
    let runCount = 0;
    __resetMigrationsForTest();
    // 注入计数迁移:两并发 ensureMigrated 应共享同一 Promise、只跑一次。
    const { __setMigrationsForTest } = await import("../migrations.js");
    __setMigrationsForTest([
      {
        id: 1,
        name: "counted",
        up: async () => {
          runCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      },
    ]);
    const [a, b] = await Promise.all([ensureMigrated(), ensureMigrated()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(runCount).toBe(1);
    __resetMigrationsForTest();
  });
});

describe("迁移前自动备份", () => {
  it("存在未应用迁移且为 file: 库时生成备份;无未应用迁移不备份", async () => {
    const client = getDocumentsClient();
    // 先建库文件(跑一条迁移落盘)。
    await runMigrations([{ id: 1, name: "one", up: async () => {} }]);

    // 存在 id=2 未应用 → 触发备份。
    const r = await runMigrations([
      { id: 1, name: "one", up: async () => {} },
      { id: 2, name: "two", up: async (c) => void (await c.execute("CREATE TABLE t2 (x TEXT)")) },
    ]);
    expect(r.backupPath).toBeTruthy();
    expect(existsSync(r.backupPath as string)).toBe(true);
    expect(r.backupPath).toMatch(/\.bak-pre-v2-\d{14}$/);

    // 再跑无未应用迁移 → 不备份。
    const r2 = await runMigrations([
      { id: 1, name: "one", up: async () => {} },
      { id: 2, name: "two", up: async () => {} },
    ]);
    expect(r2.backupPath).toBeNull();
    void client;
  });

  it("只保留最近 3 份备份", async () => {
    const dir = db.tempDir;
    const client = getDocumentsClient();
    await runMigrations([{ id: 1, name: "one", up: async () => {} }]);
    const dbBase = "documents.db";
    // 伪造 4 份历史备份(不同时间戳)。
    for (const ts of ["20260101000001", "20260101000002", "20260101000003"]) {
      writeFileSync(join(dir, `${dbBase}.bak-pre-v1-${ts}`), "old");
    }
    // 触发一次真实备份(第 4 份),prune 后应只剩最近 3 份。
    await runMigrations([
      { id: 1, name: "one", up: async () => {} },
      { id: 2, name: "two", up: async () => {} },
    ]);
    const baks = readdirSync(dir)
      .filter((f) => f.startsWith(`${dbBase}.bak-pre-v`) && !f.endsWith("-wal") && !f.endsWith("-shm"))
      .sort();
    expect(baks.length).toBe(3);
    // 最老的 20260101000001 应被清掉。
    expect(baks.some((f) => f.includes("20260101000001"))).toBe(false);
    void client;
  });

  it("跨版本位数时按时间裁剪且保留本次迁移前备份", async () => {
    const dir = db.tempDir;
    const migrations: Migration[] = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      name: `migration_${index + 1}`,
      up: async () => {},
    }));
    await runMigrations(migrations.slice(0, 9));
    const dbBase = "documents.db";
    for (const ts of ["20250101000001", "20250101000002", "20250101000003"]) {
      writeFileSync(join(dir, `${dbBase}.bak-pre-v9-${ts}`), "old");
    }

    const result = await runMigrations(migrations);

    expect(result.backupPath).toMatch(/\.bak-pre-v10-\d{14}$/);
    expect(existsSync(result.backupPath as string)).toBe(true);
    const baks = readdirSync(dir)
      .filter((name) => name.startsWith(`${dbBase}.bak-pre-v`))
      .filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm"));
    expect(baks).toHaveLength(3);
    expect(baks.some((name) => name.endsWith("20250101000001"))).toBe(false);
  });
});
