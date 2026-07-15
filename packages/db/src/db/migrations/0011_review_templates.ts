import type { Client } from "@libsql/client";
import type { Migration } from "./types.js";

export const REVIEW_TEMPLATE_SEEDS = [
  {
    id: "review-sensitive-default",
    type: "sensitive",
    name: "标准敏感词审查",
    prompt:
      "严格按已选择的敏感词词库扫描当前文档，逐条处理全部命中，不得因语境、专有名词或引用而自行豁免。有明确 replacement 的命中按词库直接做逐处最小替换；replacement 为空的仅标记命中必须逐条创建批注，summary≤15字，引句等于命中原词，并写清词库备注、命中上下文与人工确认点。拿不准风险时降为 severity=info 也必须呈现，禁止只在聊天中说明。零命中时如实说明，不得凭空补造风险词。",
  },
  {
    id: "review-source-default",
    type: "source",
    name: "标准来源核查",
    prompt:
      "仅以当前会话素材为依据，重点核对时间与日期先后、金额/数字/单位与统计口径、人名职务与机构名、引述内容与素材原文是否一致；将口径漂移、无据或数字失真问题创建为批注组，素材中查不到依据的断言标记为无据，默认不联网补证。",
  },
] as const;

async function up(client: Client): Promise<void> {
  const statements = [
    `CREATE TABLE review_templates (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    "CREATE INDEX idx_review_templates_type_builtin ON review_templates(type, builtin DESC, name)",
    `CREATE TABLE review_doc_supplements (
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      supplement TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(doc_id, type)
    )`,
    `CREATE TABLE review_template_selections (
      type TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES review_templates(id) ON DELETE CASCADE,
      updated_at TEXT NOT NULL
    )`,
  ];
  for (const sql of statements) await client.execute(sql);

  const now = new Date().toISOString();
  for (const seed of REVIEW_TEMPLATE_SEEDS) {
    await client.execute({
      sql: `INSERT INTO review_templates(id,type,name,prompt,builtin,created_at,updated_at)
        VALUES(?,?,?,?,1,?,?)`,
      args: [seed.id, seed.type, seed.name, seed.prompt, now, now],
    });
  }

  // B18 去 AI 味已具备多模板心智；复制进新的审查模板库并保留用户修改/builtin 标记。
  await client.execute({
    sql: `INSERT OR IGNORE INTO review_templates(id,type,name,prompt,builtin,created_at,updated_at)
      SELECT 'review-' || resource_id, 'deai', name, prompt, builtin, ?, ?
      FROM style_templates WHERE dtype='deai' AND slot='instruction'`,
    args: [now, now],
  });

  // B18 的固定 id 常驻指令迁为用户模板。空值不制造无效模板；非空用户内容原样保留。
  await client.execute({
    sql: `INSERT OR IGNORE INTO review_templates(id,type,name,prompt,builtin,created_at,updated_at)
      SELECT 'review-migrated-' || resource_id,
        CASE WHEN resource_id='review-source-instruction' OR name='来源审查指令' THEN 'source' ELSE 'sensitive' END,
        name || '（迁移）', prompt, 0, ?, ?
      FROM style_templates
      WHERE dtype='review' AND slot='instruction' AND trim(prompt) <> ''
        AND (resource_id IN ('review-sensitive-instruction','review-source-instruction')
          OR name IN ('敏感词审查指令','来源审查指令'))`,
    args: [now, now],
  });

  for (const [type, fallbackId] of [
    ["sensitive", "review-sensitive-default"],
    ["deai", "review-deai-light"],
    ["source", "review-source-default"],
  ] as const) {
    await client.execute({
      sql: `INSERT INTO review_template_selections(type,template_id,updated_at)
        SELECT ?, COALESCE((SELECT id FROM review_templates WHERE type=? AND builtin=1 ORDER BY id LIMIT 1), ?), ?`,
      args: [type, type, fallbackId, now],
    });
  }

  // 有固定指令存量时，迁移模板必须成为该类型当前选择，确保升级后立即可见可用。
  await client.execute({
    sql: `UPDATE review_template_selections SET template_id=(
        SELECT id FROM review_templates WHERE type='sensitive' AND id LIKE 'review-migrated-%' ORDER BY id LIMIT 1
      ), updated_at=?
      WHERE type='sensitive' AND EXISTS(
        SELECT 1 FROM review_templates WHERE type='sensitive' AND id LIKE 'review-migrated-%'
      )`,
    args: [now],
  });
  await client.execute({
    sql: `UPDATE review_template_selections SET template_id=(
        SELECT id FROM review_templates WHERE type='source' AND id LIKE 'review-migrated-%' ORDER BY id LIMIT 1
      ), updated_at=?
      WHERE type='source' AND EXISTS(
        SELECT 1 FROM review_templates WHERE type='source' AND id LIKE 'review-migrated-%'
      )`,
    args: [now],
  });
}

export const migration0011ReviewTemplates: Migration = {
  id: 11,
  name: "review_templates",
  up,
};
