import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0015RoleReviewTemplates } from "../migrations/0015_role_review_templates.js";
import {
  INSERTED_REVIEW_R4_SEEDS,
  MOVED_ROLE_REVIEW_IDS,
} from "../../seeds/reviewRoleTemplatePrompts.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0015-"); });
afterEach(() => db.cleanup());

const PROMPT_SHA256: Record<string, string> = {
  "review-role-engineer": "2076a434c97fc407690535809fb2d944fd6a52761e54745ceead7ee5ee5551b8",
  "review-role-hr": "16bbc5a3270e6ea4345e43dc784d458b8fb527d7ccbc783c3fdb48bd077de598",
  "review-role-client": "f9be8f0c42bd21ef37ac1e01454b80ae91b926851e219ecb3944d781d93f03c3",
  "review-role-academic": "778545a6231d60322890a22b87783cdd81f4a1b5a0644deec8d7f36c8e3d2c35",
  "review-role-editor": "18afdb43919d3bf6493e55e70431cec6a223c6c9baaf5dc3c2439404c4bff2ac",
  "review-role-newcomer": "cea87d1ccd58cdc98162e8e7845280572cc4a9d26a3a3bbe5870c62be8c2ad95",
  "review-role-interviewer": "d4276f577a1e036228302e447ba33aa6174b0ea8902eea646fac84e7d5d3504e",
  "review-role-investor": "43d58f7fe38430f32aa6109afce0813b05fe535d0e82ca9a63e003d7a97bf9fe",
  "review-role-competitor": "aeb25fe4af414f12482f1b79dd73bf125587bbfa2915c041ad1df895fe433cf9",
  "review-role-beginner": "96b9fd5d6c206744003be0a842102b9473b35a41141bf388493d17829cab6612",
  "review-custom-logic": "833be30a95f5b924fc07d1706da3eaef7e5e5faf23af06cde04b8a497b1c06ce",
  "review-custom-virality": "5395a48ea04443d33647ca5ff421cd16910086eff5e72ec6b1c1650f7d4fc2d3",
};

describe("0015 role review templates", () => {
  it("无 type CHECK 时原样搬家，固定 id 入种子并设置 role/custom 默认选择", async () => {
    await runMigrations(MIGRATIONS.slice(0, 14));
    const client = getDocumentsClient();
    const schema = await client.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='review_templates'");
    expect(String(schema.rows[0]?.sql)).not.toContain("CHECK");

    const beforeMoved = await client.execute({
      sql: "SELECT id,prompt,builtin FROM review_templates WHERE id IN (?,?) ORDER BY id",
      args: [...MOVED_ROLE_REVIEW_IDS],
    });
    await migration0015RoleReviewTemplates.up(client);

    const moved = await client.execute({
      sql: "SELECT id,type,prompt,builtin FROM review_templates WHERE id IN (?,?) ORDER BY id",
      args: [...MOVED_ROLE_REVIEW_IDS],
    });
    expect(moved.rows.map((row) => ({ id: row.id, prompt: row.prompt, builtin: row.builtin })))
      .toEqual(beforeMoved.rows.map((row) => ({ id: row.id, prompt: row.prompt, builtin: row.builtin })));
    expect(moved.rows.every((row) => row.type === "role")).toBe(true);

    const roleRows = await client.execute("SELECT id,type,builtin FROM review_templates WHERE type='role'");
    expect(roleRows.rows).toHaveLength(12);
    expect(new Set(roleRows.rows.map((row) => row.id))).toEqual(new Set([
      "review-role-engineer", "review-role-hr", "review-role-client", "review-role-academic",
      "review-role-editor", "review-role-newcomer", "review-role-interviewer",
      "review-custom-legal", "review-custom-boss", "review-role-investor",
      "review-role-competitor", "review-role-beginner",
    ]));
    expect(roleRows.rows.every((row) => row.builtin === 1)).toBe(true);

    const customRows = await client.execute("SELECT id FROM review_templates WHERE type='custom' ORDER BY id");
    expect(customRows.rows.map((row) => row.id)).toEqual(["review-custom-logic", "review-custom-virality"]);
    const selections = await client.execute(
      "SELECT type,template_id FROM review_template_selections WHERE type IN ('role','custom') ORDER BY type",
    );
    expect(selections.rows).toMatchObject([
      { type: "custom", template_id: "review-custom-logic" },
      { type: "role", template_id: "review-role-engineer" },
    ]);
  });

  it("12 条新增/升级文案字节级锁定，重复执行不增行也不覆盖选择", async () => {
    await runMigrations(MIGRATIONS.slice(0, 14));
    const client = getDocumentsClient();
    await migration0015RoleReviewTemplates.up(client);

    for (const seed of INSERTED_REVIEW_R4_SEEDS) {
      expect(createHash("sha256").update(seed.prompt).digest("hex"), seed.id).toBe(PROMPT_SHA256[seed.id]);
      const row = await client.execute({ sql: "SELECT type,name,prompt,builtin FROM review_templates WHERE id=?", args: [seed.id] });
      expect(row.rows[0]).toMatchObject({ type: seed.type, name: seed.name, prompt: seed.prompt, builtin: 1 });
    }

    await client.execute("UPDATE review_template_selections SET template_id='review-role-investor' WHERE type='role'");
    await migration0015RoleReviewTemplates.up(client);
    expect(Number((await client.execute("SELECT COUNT(*) AS n FROM review_templates WHERE type='role'")).rows[0]?.n)).toBe(12);
    expect((await client.execute("SELECT template_id FROM review_template_selections WHERE type='role'")).rows[0]?.template_id)
      .toBe("review-role-investor");
  });

  it("已有库搬家不改用户覆盖内容/builtin，并保留仍有效的 custom 选择", async () => {
    await runMigrations(MIGRATIONS.slice(0, 14));
    const client = getDocumentsClient();
    const now = "2026-07-15T00:00:00.000Z";
    await client.execute("UPDATE review_templates SET prompt='用户覆盖法务规则',builtin=0 WHERE id='review-custom-legal'");
    await client.execute({
      sql: `INSERT INTO review_templates(id,type,name,prompt,builtin,created_at,updated_at)
        VALUES('review-user-custom','custom','用户自定义','用户规则',0,?,?)`,
      args: [now, now],
    });
    await client.execute("UPDATE review_template_selections SET template_id='review-user-custom' WHERE type='custom'");

    await migration0015RoleReviewTemplates.up(client);

    expect((await client.execute("SELECT type,prompt,builtin FROM review_templates WHERE id='review-custom-legal'")).rows[0])
      .toMatchObject({ type: "role", prompt: "用户覆盖法务规则", builtin: 0 });
    expect((await client.execute("SELECT template_id FROM review_template_selections WHERE type='custom'")).rows[0]?.template_id)
      .toBe("review-user-custom");
  });
});
