import type { Client } from "@libsql/client";
import type { Migration } from "./types.js";

export const STYLE_TEMPLATE_SEEDS = [
  { id: "gzh-layout-classic", dtype: "gzh", slot: "layout", name: "微信经典排版", detail: "短段落、清晰小节与重点高亮的经典公众号版式。", prompt: "采用微信经典排版：开头用一个贴合原文的钩子快速进入主题；正文使用短段落，每段聚焦一个意思；按内容层级使用二级小标题（h2）组织小节，不用文字编号伪装标题层级；关键句独立成段，并用 <mark> 标出真正需要强调的短句，避免整段高亮；小节之间保持清晰节奏；结尾设置自然的互动或关注引导。" },
  { id: "gzh-layout-minimal", dtype: "gzh", slot: "layout", name: "极简长文排版", detail: "少分节、弱装饰，适合连续沉浸阅读。", prompt: "采用极简长文排版：减少分节，只在主题明显转折时使用二级小标题（h2）；以较长但易读的连续段落承载完整论述，避免频繁拆成碎句；不使用装饰性符号或密集高亮，仅对极少数核心判断使用 <mark>；保持克制、连贯、沉浸的阅读节奏。" },
  { id: "gzh-deep", dtype: "gzh", slot: "writing", name: "深度长文", detail: "完整保留论证，以自然、克制的公众号语感展开。", prompt: "完整保留原文的事实、核心观点与论证结构，改写成自然、克制且有纵深的公众号内容；严禁虚构原文没有的事实、案例、数据或引语。公众号正文不允许外链：移除一切 <a>，不得输出裸 URL；链接承载的必要信息改为纯文字表述，适合时可改写为“公众号后台回复XX”等站内引导。" },
  { id: "gzh-news", dtype: "gzh", slot: "writing", name: "资讯快讯", detail: "核心要点前置，压缩成清楚利落的资讯稿。", prompt: "将原文压缩改写为 600—900 字的资讯快讯体：核心要点前置，事实与结论清楚，只使用原文信息，严禁虚构原文没有的事实、案例、数据或引语。公众号正文不允许外链：移除一切 <a>，不得输出裸 URL；链接承载的必要信息改为纯文字表述，适合时可改写为“公众号后台回复XX”等站内引导。" },
  { id: "xhs-seed", dtype: "xhs", slot: "writing", name: "种草笔记", detail: "第一人称体验、短段落与自然互动的种草笔记。", prompt: "以第一人称真实体验视角，将源文改写为小红书种草笔记。用具体痛点或使用场景开头形成钩子；标题不超过 20 个汉字并自然带 1—2 个 emoji。正文 600—900 字，口语化表达，每段 1—3 句、段落短而有呼吸感，自然穿插 emoji，但不要堆砌。只使用源文已有事实、体验、案例、数据和结论，严禁虚构或夸大。结尾用一句提问式互动引导；最后必须另起一个独立段落，放 4—6 个与正文高度相关的话题标签，严格使用“#话题词”格式并以空格分隔，标签后不再添加正文。" },
  { id: "xhs-list", dtype: "xhs", slot: "writing", name: "干货清单", detail: "数字清单结构，强调清晰、实用和收藏价值。", prompt: "将源文改写为适合收藏的小红书数字清单笔记。标题不超过 20 个汉字，采用“XX 的 N 个要点⚡”一类清晰结构并自然带 1—2 个 emoji；开头用痛点或使用场景快速说明收藏价值。正文 600—900 字、口语化，每一条都由简短小标题加 1—2 句说明组成，段落短而清楚，可自然穿插 emoji。只使用源文已有事实、案例、数据和结论，严禁虚构、补造或夸大。结尾用一句提问式互动引导；最后必须另起一个独立段落，放 4—6 个相关话题标签，严格使用“#话题词”格式并以空格分隔，标签后不再添加正文。" },
] as const;

async function hasColumn(client: Client, table: string, column: string): Promise<boolean> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return result.rows.some((row) => String(row.name) === column);
}

async function up(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS style_templates (
    resource_id TEXT PRIMARY KEY REFERENCES skill_resources(id) ON DELETE CASCADE,
    dtype TEXT NOT NULL,
    slot TEXT NOT NULL CHECK(slot IN ('layout','writing')),
    name TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0
  )`);
  await client.execute("CREATE INDEX IF NOT EXISTS idx_style_templates_dtype_slot ON style_templates(dtype, slot)");
  if (!(await hasColumn(client, "document_derivatives", "layout_style_id"))) {
    await client.execute("ALTER TABLE document_derivatives ADD COLUMN layout_style_id TEXT NULL");
  }
  const now = new Date().toISOString();
  for (const seed of STYLE_TEMPLATE_SEEDS) {
    // INSERT OR IGNORE 保留用户对预制模板的修改；一旦经 repo 更新会转 builtin=0。
    await client.execute({ sql: `INSERT OR IGNORE INTO skill_resources (id,kind,name,meta_json,created_at,updated_at)
      VALUES (?, 'style-template', ?, '{}', ?, ?)`, args: [seed.id, seed.name, now, now] });
    await client.execute({ sql: `INSERT OR IGNORE INTO style_templates
      (resource_id,dtype,slot,name,detail,prompt,builtin) VALUES (?,?,?,?,?,?,1)`,
      args: [seed.id, seed.dtype, seed.slot, seed.name, seed.detail, seed.prompt] });
  }
  await client.execute("UPDATE document_derivatives SET layout_style_id = 'gzh-layout-classic' WHERE dtype = 'gzh' AND layout_style_id IS NULL");
}

export const migration0007StyleTemplates: Migration = { id: 7, name: "style_templates", up };
