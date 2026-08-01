import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REVIEW_TEMPLATE_PROMPT_SEEDS } from "../../seeds/reviewTemplatePrompts.js";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0035ContextualSensitiveReplacement } from "../migrations/0035_contextual_sensitive_replacement.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0035-"); });
afterEach(() => db.cleanup());

describe("0035 contextual sensitive replacement", () => {
  it("刷新内置敏感词纪律并清理历史占位候选，不覆盖用户模板和已改词条", async () => {
    await runMigrations(MIGRATIONS.slice(0, 34));
    const client = getDocumentsClient();
    const now = new Date().toISOString();
    await client.execute("UPDATE review_templates SET prompt='旧直替提示' WHERE id='review-sensitive-default'");
    await client.execute({
      sql: `INSERT INTO review_templates(id,type,name,prompt,builtin,created_at,updated_at)
        VALUES('review-sensitive-user','sensitive','用户敏感词模板','用户自定义直替规则',0,?,?)`,
      args: [now, now],
    });
    await client.execute(
      "UPDATE lexicon_entries SET replacement='此处' WHERE resource_id='lexicon-official-writing' AND word='这块'",
    );

    await migration0035ContextualSensitiveReplacement.up(client);

    const seed = REVIEW_TEMPLATE_PROMPT_SEEDS.find((item) => item.id === "review-sensitive-default")!;
    const builtin = await client.execute("SELECT prompt FROM review_templates WHERE id='review-sensitive-default'");
    const user = await client.execute("SELECT prompt FROM review_templates WHERE id='review-sensitive-user'");
    const entries = await client.execute(
      "SELECT word,replacement FROM lexicon_entries WHERE resource_id='lexicon-official-writing' AND word IN ('这块','那块') ORDER BY word",
    );

    expect(builtin.rows[0]?.prompt).toBe(seed.prompt);
    expect(seed.prompt).toContain("replacementHint 只作候选参考");
    expect(seed.prompt).toContain("无合适改写时只标注并省略 suggestion");
    expect(user.rows[0]?.prompt).toBe("用户自定义直替规则");
    expect(entries.rows).toEqual([
      expect.objectContaining({ word: "这块", replacement: "此处" }),
      expect.objectContaining({ word: "那块", replacement: null }),
    ]);
  });
});
