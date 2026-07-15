import type { Client } from "@libsql/client";
import type { Migration } from "./types.js";

const OPERATION_RULES = `

操作规范：先 readDraft 定位；逐块用 editDraft replaceText/replaceBlock 小步修改，禁止整篇 writeDraft；每处只改 AI 痕迹本身，不顺手增删事实；零命中直说文本自然，禁止硬改。`;

export const DEAI_STYLE_TEMPLATE_SEEDS = [
  {
    id: "deai-light",
    dtype: "deai",
    slot: "instruction",
    name: "轻度去味",
    detail: "只清理最重的 AI 痕迹，保留原有结构与篇幅。整理自 Humanizer-zh 与 Wikipedia AI 写作特征清单。",
    prompt: `轻度去味：只处理最明显、最影响自然度的 AI 写作痕迹，以逐处最小替换为原则，保留全文结构、句序与篇幅。重点检查并处理：高频 AI 词汇（此外、至关重要、深入探讨、综上所述、值得注意的是）；填充短语（为了实现这一目标、在这个时间点）；万能积极结尾（未来可期、让我们拭目以待）；“不仅……而且……”式否定排比；“标志着、彰显”式过度赋义。不要重排段落，不要为了变化而改写本来已经自然的句子。${OPERATION_RULES}`,
  },
  {
    id: "deai-deep",
    dtype: "deai",
    slot: "instruction",
    name: "深度重写",
    detail: "按 24 类 AI 痕迹逐段全面检查并重写。整理自 Humanizer-zh 与 Wikipedia AI 写作特征清单。",
    prompt: `深度重写：按 24 类 AI 写作痕迹逐段检查并重写。除轻度去味中的高频 AI 词、填充短语、万能积极结尾、否定式排比和过度赋义外，还要处理：强行凑三组的三段式法则；“尽管存在挑战……仍蓬勃发展”一类提纲式公式段；-ing 尾缀式空泛升华；“专家认为、报告显示”等模糊归因（能给出原文已有实指就给实指，否则删除归因，不得虚构来源）；从 X 到 Y 但两端无实质关联的虚假范围；破折号与粗体过度；刻意金句化、像为引用而写的句子。遵循五项原则：删填充；破公式；改变节奏，长短句混合且两项列举优先于强凑三项；信任读者，直接陈述并去掉软化辩解；删除刻意金句。保留所有事实与有效信息，不虚构、不漏减。${OPERATION_RULES}`,
  },
  {
    id: "deai-spoken",
    dtype: "deai",
    slot: "instruction",
    name: "口语人味",
    detail: "增加第一人称颗粒感与自然口语节奏。整理自 Humanizer-zh 与 Wikipedia AI 写作特征清单。",
    prompt: `口语人味：在语义忠实、不虚构事实的前提下，增加第一人称的颗粒感。用原文已有的具体例子替代“赋能、助力、引领、打造”等抽象大词；允许自然的思维跳跃与不完美转折，不要把每一步都解释得过分周全；拆掉“首先、其次、最后”等提纲式过渡词；让句长明显参差，短句与较长句自然交替。具体例子只能来自原文，不得补造经历、场景、数据或观点。${OPERATION_RULES}`,
  },
] as const;

async function up(client: Client): Promise<void> {
  const now = new Date().toISOString();
  for (const seed of DEAI_STYLE_TEMPLATE_SEEDS) {
    await client.execute({
      sql: `INSERT OR IGNORE INTO skill_resources(id,kind,name,meta_json,created_at,updated_at)
        VALUES(?,'style-template',?,'{}',?,?)`,
      args: [seed.id, seed.name, now, now],
    });
    await client.execute({
      sql: `INSERT OR IGNORE INTO style_templates(resource_id,dtype,slot,name,detail,prompt,builtin)
        VALUES(?,?,?,?,?,?,1)`,
      args: [seed.id, seed.dtype, seed.slot, seed.name, seed.detail, seed.prompt],
    });
  }
}

export const migration0009DeaiStyleTemplates: Migration = {
  id: 9,
  name: "deai_style_templates",
  up,
};
