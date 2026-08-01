import { REVIEW_TEMPLATE_PROMPT_SEEDS } from "../../seeds/reviewTemplatePrompts.js";
import type { Migration } from "./types.js";

const SENSITIVE_TEMPLATE_ID = "review-sensitive-default";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  const seed = REVIEW_TEMPLATE_PROMPT_SEEDS.find((item) => item.id === SENSITIVE_TEMPLATE_ID);
  if (!seed) throw new Error("缺少标准敏感词审查提示词种子");

  const now = new Date().toISOString();
  await client.execute({
    sql: `UPDATE review_templates
      SET prompt=?,updated_at=?
      WHERE id=? AND builtin=1`,
    args: [seed.prompt, now, SENSITIVE_TEMPLATE_ID],
  });

  // 历史内置词条把方位量词机械映射为占位词，会生成“该事项铭牌”等坏句。
  // 只清理仍保持历史默认值的两条，用户已自行修改的候选不覆盖。
  await client.execute({
    sql: `UPDATE lexicon_entries
      SET replacement=NULL,updated_at=?
      WHERE resource_id='lexicon-official-writing'
        AND word IN ('这块','那块')
        AND replacement='该事项'`,
    args: [now],
  });
}

export const migration0035ContextualSensitiveReplacement: Migration = {
  id: 35,
  name: "contextual_sensitive_replacement",
  up,
};
