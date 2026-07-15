import type { Client } from "@libsql/client";
import {
  INSERTED_REVIEW_R4_SEEDS,
  MOVED_ROLE_REVIEW_IDS,
} from "../../seeds/reviewRoleTemplatePrompts.js";
import type { Migration } from "./types.js";

async function up(client: Client): Promise<void> {
  const now = new Date().toISOString();

  // 0011 的 review_templates.type 没有 CHECK 约束，直接搬家即可；内容与 builtin 原样保留。
  await client.execute({
    sql: `UPDATE review_templates SET type=?,updated_at=? WHERE id IN (?,?) AND type<>?`,
    args: ["role", now, ...MOVED_ROLE_REVIEW_IDS, "role"],
  });

  for (const seed of INSERTED_REVIEW_R4_SEEDS) {
    await client.execute({
      sql: `INSERT INTO review_templates(id,type,name,prompt,builtin,created_at,updated_at)
        VALUES(?,?,?,?,1,?,?)
        ON CONFLICT(id) DO UPDATE SET
          type=excluded.type,name=excluded.name,prompt=excluded.prompt,builtin=1,updated_at=excluded.updated_at
        WHERE review_templates.builtin=1`,
      args: [seed.id, seed.type, seed.name, seed.prompt, now, now],
    });
  }

  // r3 fresh 库默认选中法务；搬家后把失配选择落到新的 custom 第一种子。
  await client.execute({
    sql: `UPDATE review_template_selections
      SET template_id='review-custom-logic',updated_at=?
      WHERE type='custom' AND template_id IN (?,?)`,
    args: [now, ...MOVED_ROLE_REVIEW_IDS],
  });

  // 只在 role 还没有选择时写入第一个种子，重复执行不覆盖用户的选中记忆。
  await client.execute({
    sql: `INSERT OR IGNORE INTO review_template_selections(type,template_id,updated_at)
      VALUES('role','review-role-engineer',?)`,
    args: [now],
  });
}

export const migration0015RoleReviewTemplates: Migration = {
  id: 15,
  name: "role_review_templates",
  up,
};
