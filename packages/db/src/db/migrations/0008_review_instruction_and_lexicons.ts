import type { Client } from "@libsql/client";
import type { Migration } from "./types.js";

type SeedEntry = readonly [word: string, replacement: string | null, note: string];

const AD_NOTE = "依据《广告法》第九条绝对化用语口径，仅标记并结合具体语境人工判断";
const MEDICAL_NOTE = "非药品/器械不得作医疗功效宣称口径，仅标记并结合商品资质与语境人工判断";
const MEDIA_NOTE = "依据广告合规与平台营销内容治理常见高风险口径整理，需结合活动规则与资质人工判断";

export const REVIEW_LEXICON_SEEDS: ReadonlyArray<{ id: string; name: string; description: string; entries: readonly SeedEntry[] }> = [
  {
    id: "lexicon-advertising-superlatives", name: "广告法极限词",
    description: "依据《广告法》第九条及绝对化用语监管口径整理，适用于广告、商品详情与营销文案发布前审查。",
    entries: [
      ["国家级", null, AD_NOTE], ["世界级", null, AD_NOTE], ["宇宙级", null, AD_NOTE], ["全球级", null, AD_NOTE],
      ["最高级", null, AD_NOTE], ["最高", null, AD_NOTE], ["最佳", null, AD_NOTE], ["最好", null, AD_NOTE],
      ["最优", null, AD_NOTE], ["最强", null, AD_NOTE], ["最大", null, AD_NOTE], ["最先进", null, AD_NOTE],
      ["最权威", null, AD_NOTE], ["最专业", null, AD_NOTE], ["第一", null, AD_NOTE], ["全国第一", null, AD_NOTE],
      ["全球第一", null, AD_NOTE], ["行业第一", null, AD_NOTE], ["销量第一", null, AD_NOTE], ["排名第一", null, AD_NOTE],
      ["唯一", null, AD_NOTE], ["唯一指定", null, AD_NOTE], ["首选", null, AD_NOTE], ["顶级", null, AD_NOTE],
      ["极品", null, AD_NOTE], ["至尊", null, AD_NOTE], ["巅峰", null, AD_NOTE], ["万能", null, AD_NOTE],
      ["100%", null, AD_NOTE], ["百分之百", null, AD_NOTE], ["绝对", null, AD_NOTE], ["绝无仅有", null, AD_NOTE],
      ["独一无二", null, AD_NOTE], ["史无前例", null, AD_NOTE], ["前无古人", null, AD_NOTE], ["永久", null, AD_NOTE],
      ["最低价", "价格优惠", AD_NOTE], ["全网最低", "价格优惠", AD_NOTE], ["全网最低价", "价格优惠", AD_NOTE],
      ["史上最低价", "价格优惠", AD_NOTE], ["空前绝后", null, AD_NOTE], ["顶尖", null, AD_NOTE],
    ],
  },
  {
    id: "lexicon-medical-health-claims", name: "医疗健康违禁宣称",
    description: "按非药品、非医疗器械不得宣称疾病治疗功效的监管口径整理，适用于食品、保健品、日化及健康内容。",
    entries: [
      ["根治", null, MEDICAL_NOTE], ["彻底根治", null, MEDICAL_NOTE], ["治愈", null, MEDICAL_NOTE], ["治愈率", null, MEDICAL_NOTE],
      ["包治", null, MEDICAL_NOTE], ["药到病除", null, MEDICAL_NOTE], ["一次见效", null, MEDICAL_NOTE], ["立即见效", null, MEDICAL_NOTE],
      ["立刻见效", null, MEDICAL_NOTE], ["速效", null, MEDICAL_NOTE], ["特效", null, MEDICAL_NOTE], ["疗效最佳", null, MEDICAL_NOTE],
      ["无副作用", null, MEDICAL_NOTE], ["零副作用", null, MEDICAL_NOTE], ["绝无副作用", null, MEDICAL_NOTE], ["安全无害", null, MEDICAL_NOTE],
      ["绝对安全", null, MEDICAL_NOTE], ["无任何风险", null, MEDICAL_NOTE], ["彻底根除", null, MEDICAL_NOTE], ["永不复发", null, MEDICAL_NOTE],
      ["防止复发", null, MEDICAL_NOTE], ["抗癌", null, MEDICAL_NOTE], ["防癌", null, MEDICAL_NOTE], ["抑制肿瘤", null, MEDICAL_NOTE],
      ["降血压", null, MEDICAL_NOTE], ["降血糖", null, MEDICAL_NOTE], ["降血脂", null, MEDICAL_NOTE], ["治疗失眠", null, MEDICAL_NOTE],
      ["治疗近视", null, MEDICAL_NOTE], ["修复视力", null, MEDICAL_NOTE], ["消炎", null, MEDICAL_NOTE], ["抗菌消炎", null, MEDICAL_NOTE],
      ["排毒", null, MEDICAL_NOTE], ["清除毒素", null, MEDICAL_NOTE], ["增强免疫力", null, MEDICAL_NOTE], ["提高免疫力", null, MEDICAL_NOTE],
      ["改善免疫", null, MEDICAL_NOTE], ["替代药物", null, MEDICAL_NOTE], ["无需就医", null, MEDICAL_NOTE], ["告别疾病", null, MEDICAL_NOTE],
    ],
  },
  {
    id: "lexicon-official-writing", name: "公文规范用语对照",
    description: "按机关公文庄重、准确、简明的表达原则整理口语到书面语对照，适用于通知、请示、报告与工作总结。",
    entries: [
      ["搞", "开展", "口语改为规范书面语"], ["搞好", "做好", "口语改为规范书面语"], ["搞定", "完成", "口语改为规范书面语"],
      ["搞清楚", "查明", "口语改为规范书面语"], ["搞一下", "予以推进", "口语改为规范书面语"], ["抓一下", "予以落实", "口语改为规范书面语"],
      ["抓好", "切实做好", "口语改为规范书面语"], ["弄", "办理", "口语改为规范书面语"], ["弄好", "妥善办理", "口语改为规范书面语"],
      ["弄清", "查明", "口语改为规范书面语"], ["蛮", "较为", "口语改为规范书面语"], ["挺", "较为", "口语改为规范书面语"],
      ["马上", "立即", "口语改为规范书面语"], ["赶紧", "及时", "口语改为规范书面语"], ["尽快点", "尽快", "口语改为规范书面语"],
      ["差不多", "基本", "口语改为规范书面语，必要时补充准确范围"], ["好多", "较多", "口语改为规范书面语"], ["不少", "较多", "口语改为规范书面语"],
      ["一点儿", "少量", "口语改为规范书面语"], ["这块", "该事项", "口语改为规范书面语"], ["那块", "该事项", "口语改为规范书面语"],
      ["这个事", "此事", "口语改为规范书面语"], ["这么办", "按此办理", "口语改为规范书面语"], ["怎么办", "如何办理", "口语改为规范书面语"],
      ["说一下", "说明", "口语改为规范书面语"], ["讲一下", "说明", "口语改为规范书面语"], ["问一下", "询问", "口语改为规范书面语"],
      ["看一下", "查阅", "口语改为规范书面语"], ["查一下", "核查", "口语改为规范书面语"], ["想办法", "研究措施", "口语改为规范书面语"],
      ["碰一下", "沟通", "口语改为规范书面语"], ["碰头", "会商", "口语改为规范书面语"], ["打个招呼", "事先告知", "口语改为规范书面语"],
      ["给个说法", "作出说明", "口语改为规范书面语"], ["有啥", "有何", "口语改为规范书面语"], ["没啥", "无其他事项", "口语改为规范书面语"],
      ["不行", "不可行", "口语改为规范书面语"], ["行不通", "不可行", "口语改为规范书面语"], ["好好", "认真", "口语改为规范书面语"],
      ["来不及", "时间紧迫", "口语改为规范书面语"],
    ],
  },
  {
    id: "lexicon-social-media-marketing", name: "自媒体营销高危词",
    description: "按广告合规与主流平台营销治理常见风险整理，适用于直播、短视频、公众号和社交平台营销文案。",
    entries: [
      ["点击领取", "查看领取方式", MEDIA_NOTE], ["免费送", "参与活动可领取", MEDIA_NOTE], ["立即抢购", "查看商品详情", MEDIA_NOTE],
      ["马上抢", "查看活动详情", MEDIA_NOTE], ["错过再等一年", null, MEDIA_NOTE], ["官方唯一指定", null, MEDIA_NOTE],
      ["官方指定", null, MEDIA_NOTE], ["最后一天", "活动截止日以页面规则为准", MEDIA_NOTE], ["最后机会", null, MEDIA_NOTE],
      ["仅限今天", "活动期限以页面规则为准", MEDIA_NOTE], ["限时秒杀", "限时优惠", MEDIA_NOTE], ["秒杀价", "活动价", MEDIA_NOTE],
      ["手慢无", null, MEDIA_NOTE], ["数量有限", null, MEDIA_NOTE], ["先到先得", null, MEDIA_NOTE],
      ["全员可领", null, MEDIA_NOTE], ["人人有份", null, MEDIA_NOTE], ["无门槛领取", null, MEDIA_NOTE],
      ["0元购", "优惠后价格以结算页为准", MEDIA_NOTE], ["一分钱抢", "活动价以结算页为准", MEDIA_NOTE], ["永久免费", null, MEDIA_NOTE],
      ["免费试用", null, MEDIA_NOTE], ["保证中奖", null, MEDIA_NOTE], ["百分百中奖", null, MEDIA_NOTE],
      ["稳赚不赔", null, MEDIA_NOTE], ["保本保收益", null, MEDIA_NOTE], ["躺着赚钱", null, MEDIA_NOTE],
      ["月入过万", null, MEDIA_NOTE], ["轻松变现", null, MEDIA_NOTE], ["零风险", null, MEDIA_NOTE],
      ["内部渠道", null, MEDIA_NOTE], ["内部名额", null, MEDIA_NOTE], ["独家渠道", null, MEDIA_NOTE],
      ["全网首发", null, MEDIA_NOTE], ["全网最低", "价格优惠", MEDIA_NOTE], ["价格击穿", "优惠价格", MEDIA_NOTE],
      ["买到就是赚到", null, MEDIA_NOTE], ["闭眼入", "可结合需求选择", MEDIA_NOTE], ["必买", "可按需选购", MEDIA_NOTE],
      ["冲就完了", "可查看详情后选择", MEDIA_NOTE], ["私信领福利", "私信查看活动规则", MEDIA_NOTE], ["关注领红包", "关注后查看活动规则", MEDIA_NOTE],
    ],
  },
];

async function hasInstructionSlot(client: Client): Promise<boolean> {
  const result = await client.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='style_templates'");
  return String(result.rows[0]?.sql ?? "").includes("'instruction'");
}

async function up(client: Client): Promise<void> {
  if (!(await hasInstructionSlot(client))) {
    const statements = [
      `CREATE TABLE style_templates_new (
        resource_id TEXT PRIMARY KEY REFERENCES skill_resources(id) ON DELETE CASCADE,
        dtype TEXT NOT NULL,
        slot TEXT NOT NULL CHECK(slot IN ('layout','writing','instruction')),
        name TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        builtin INTEGER NOT NULL DEFAULT 0
      )`,
      `INSERT INTO style_templates_new(resource_id,dtype,slot,name,detail,prompt,builtin)
       SELECT resource_id,dtype,slot,name,detail,prompt,builtin FROM style_templates`,
      "DROP TABLE style_templates",
      "ALTER TABLE style_templates_new RENAME TO style_templates",
      "CREATE INDEX idx_style_templates_dtype_slot ON style_templates(dtype, slot)",
    ];
    for (const sql of statements) await client.execute(sql);
  }

  const now = new Date().toISOString();
  for (const seed of REVIEW_LEXICON_SEEDS) {
    const exists = await client.execute({ sql: "SELECT 1 FROM skill_resources WHERE id=? LIMIT 1", args: [seed.id] });
    if (exists.rows.length > 0) continue;
    await client.execute({
      sql: "INSERT INTO skill_resources(id,kind,name,meta_json,created_at,updated_at) VALUES(?,'lexicon',?,?,?,?)",
      args: [seed.id, seed.name, JSON.stringify({ description: seed.description }), now, now],
    });
    for (const [index, [word, replacement, note]] of seed.entries.entries()) {
      await client.execute({
        sql: `INSERT INTO lexicon_entries(id,resource_id,word,replacement,enabled,note,created_at,updated_at)
          VALUES(?,?,?,?,1,?,?,?)`,
        args: [`${seed.id}-${index + 1}`, seed.id, word, replacement, note, now, now],
      });
    }
  }
}

export const migration0008ReviewInstructionAndLexicons: Migration = { id: 8, name: "review_instruction_and_lexicons", up };
