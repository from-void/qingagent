import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0036ReviewIgnoreSupplements } from "../migrations/0036_review_ignore_supplements.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0036-"); });
afterEach(() => db.cleanup());

describe("0036 review ignore supplements", () => {
  it("按 origin 确定性归类、保留原补充要求并在完成后退役旧表", async () => {
    await runMigrations(MIGRATIONS.slice(0, 35));
    const client = getDocumentsClient();
    await client.execute(`INSERT INTO documents(
      id,thread_id,resource_id,title,doc_state,created_at,updated_at,role
    ) VALUES('doc-ignore-migration','thread-ignore-migration','qingagent-user','迁移','editing','now','now','main')`);
    await client.execute({
      sql: `INSERT INTO review_doc_supplements(doc_id,type,supplement,created_at,updated_at)
        VALUES(?,?,?,?,?)`,
      args: ["doc-ignore-migration", "custom", "用户手写：保留英文 Product-X。", "old", "old"],
    });
    for (const signal of [
      ["signal-1", "自定义审查:逻辑链", "行动建议空泛", "尽快推动项目落地", "2026-08-01T10:00:00.000Z"],
      ["signal-2", "source-check", "数字失真", "收入为130亿元", "2026-08-02T10:00:00.000Z"],
      ["signal-3", "历史自由 origin", "历史决定", "无需补充负责人", "2026-08-03T10:00:00.000Z"],
    ]) {
      await client.execute({
        sql: `INSERT INTO review_dismissal_signals(id,doc_id,origin,summary,quote,ts)
          VALUES(?,?,?,?,?,?)`,
        args: [signal[0]!, "doc-ignore-migration", ...signal.slice(1)],
      });
    }

    await migration0036ReviewIgnoreSupplements.up(client);

    const supplements = await client.execute(
      "SELECT type,supplement FROM review_doc_supplements WHERE doc_id='doc-ignore-migration' ORDER BY type",
    );
    expect(supplements.rows).toEqual([
      expect.objectContaining({
        type: "custom",
        supplement: [
          "用户手写：保留英文 Product-X。",
          "",
          "## 已确认忽略",
          "- 已确认无需处理，不再标记：「尽快推动项目落地」(2026-08-01)",
          "- 已确认无需处理，不再标记：「无需补充负责人」(2026-08-03)",
        ].join("\n"),
      }),
      expect.objectContaining({
        type: "source",
        supplement: "## 已确认忽略\n- 已确认无需处理，不再标记：「收入为130亿元」(2026-08-02)",
      }),
    ]);
    const table = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='review_dismissal_signals'",
    );
    expect(table.rows).toEqual([]);
  });
});
