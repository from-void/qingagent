// 客户端首启 seed：往本地库写入 1~2 篇真实示例(文章 + 对话流程),
// 让打包后的桌面端「开箱即有内容」,而不是空产品。
//
// 关键约束(与用户口径一致):
//   · 这是「分叉骨架」——纯写入,**不带 once 门**;一辈子只 seed 一次的闸门由调用方
//     (桌面主进程)用 userData 下的持久标记文件控制(见 apps/desktop/src/main)。
//   · 幂等:示例用**固定 thread id**,documentRepo.save / memory.saveThread 均为 upsert,
//     即便重复调用也只覆盖同几条,不会产生重复卡片。
//   · 仅本地:桌面端进程内自带 server,客户自带 LLM API key;此处只落库,不依赖远端。
//   · 内容要尽量覆盖产品特点:对话式写作、富文本块(标题/列表/表格/引用/代码)、
//     一键导出、连接本地文件夹数据源等。
//
// 与首页/Web 完全无关——Web 端永不调用本模块。

import type {
  ChatMessage,
  LegacySection,
  PmBlockNode,
  PmDoc,
  PmInlineNode,
  PmListItemNode,
  PmTableRowNode,
} from "@qingagent/contract-ts";

import { mastra } from "../mastra.js";
import { documentRepo, projectPmDocToSections } from "@qingagent/db";
import {
  QINGAGENT_RESOURCE_ID,
  type QingagentThreadMetadata,
} from "../session/threadPersistence.js";

// —— PmDoc 块构造器 —— 每篇文档新建一个 builder,blockId 在篇内自增、确定性、唯一。
function docBuilder(prefix: string) {
  let n = 0;
  const id = () => `${prefix}-b${++n}`;
  const text = (t: string): PmInlineNode => ({ type: "text", text: t });

  const h = (level: 1 | 2 | 3, t: string): PmBlockNode => ({
    type: "heading",
    attrs: { blockId: id(), level },
    content: [text(t)],
  });
  const p = (t: string): PmBlockNode => ({
    type: "paragraph",
    attrs: { blockId: id() },
    content: t ? [text(t)] : [],
  });
  const li = (t: string): PmListItemNode => ({
    type: "listItem",
    attrs: { blockId: id() },
    content: [p(t)],
  });
  const ul = (items: string[]): PmBlockNode => ({
    type: "bulletList",
    attrs: { blockId: id() },
    content: items.map(li),
  });
  const quote = (t: string): PmBlockNode => ({
    type: "blockquote",
    attrs: { blockId: id() },
    content: [p(t)],
  });
  const code = (language: string, body: string): PmBlockNode => ({
    type: "codeBlock",
    attrs: { blockId: id(), language },
    content: [{ type: "text", text: body }],
  });
  const table = (head: string[], rows: string[][]): PmBlockNode => {
    const cell = (t: string, header: boolean): PmTableRowNode["content"][number] => ({
      type: header ? "tableHeader" : "tableCell",
      content: [{ type: "paragraph", attrs: { blockId: id() }, content: [text(t)] }],
    });
    const tableRows: PmTableRowNode[] = [
      { type: "tableRow", content: head.map((t) => cell(t, true)) },
      ...rows.map((r) => ({
        type: "tableRow" as const,
        content: r.map((t) => cell(t, false)),
      })),
    ];
    return { type: "table", attrs: { blockId: id() }, content: tableRows };
  };

  const make = (content: PmBlockNode[]): PmDoc => ({
    type: "doc",
    attrs: { schemaVersion: 1 },
    content,
  });

  return { h, p, ul, quote, code, table, make };
}

// 粗略字数(中文按字符计),用于 home 列表的 threadSummary。
function countWords(sections: LegacySection[]): number {
  let total = 0;
  for (const s of sections) {
    if ("text" in s.data && typeof s.data.text === "string") total += s.data.text.length;
    if (s.kind === "list") total += s.data.items.join("").length;
    if (s.kind === "table")
      total += s.data.head.join("").length + s.data.rows.flat().join("").length;
    if (s.kind === "code") total += s.data.body.length;
  }
  return total;
}

interface SeedSample {
  id: string;
  title: string;
  pmDoc: PmDoc;
  chatHistory?: ChatMessage[];
  /** 越新越靠前;相对「现在」往回偏移的毫秒数。 */
  agoMs: number;
}

// 把 [角色, 文本] 轮次编成 ChatMessage[](让用户直观看到"怎么问 → 生成什么")。
function mkChat(prefix: string, turns: Array<["user" | "agent", string]>): ChatMessage[] {
  const base = Date.now();
  return turns.map(([kind, body], i) => ({
    id: `${prefix}-m${i + 1}`,
    role: { kind },
    // 让时间戳随轮次递增,渲染顺序稳定。
    ts: new Date(base - (turns.length - i) * 1000).toISOString(),
    parts: [{ kind: "text", data: { body } }],
    chips: null,
  }));
}

// —— 样例一:欢迎文章(展示富文本块全家桶 + 产品能力) ——
function buildWelcome(): SeedSample {
  const b = docBuilder("seed-welcome");
  const pmDoc = b.make([
    b.h(1, "欢迎使用青简"),
    b.p("青简是一个「对话即写作」的本地文档工作台:你把想法说给它听,它边聊边把成稿写进右侧的纸面。这篇示例本身就是一篇可编辑的文档——你可以直接在它上面增删、改写,或在左侧继续追问让它帮你调整。"),

    b.h(2, "它能为你做什么"),
    b.ul([
      "对话式写作:用自然语言提需求,自动生成 / 续写 / 改写整篇文档",
      "富文本块:标题、列表、表格、引用、代码、图表、配图,一应俱全",
      "引用与素材:把资料挂进素材区,写作时随手引用、有据可查",
      "一键导出:Markdown / Word(docx) / PDF,样式高保真带走",
      "连接本地文件夹:把你电脑里的资料夹接成数据源,本地检索、不出本机",
    ]),

    b.h(2, "富文本能力一览"),
    b.p("下面这张表本身就是一个可编辑的表格块——双击单元格即可修改:"),
    b.table(
      ["能力", "说明"],
      [
        ["标题分级", "H1 / H2 / H3 自动生成大纲,长文也清清楚楚"],
        ["列表", "有序 / 无序 / 多级嵌套,要点一目了然"],
        ["表格", "支持表头、单元格底色,导出后样式保留"],
        ["代码块", "带语言高亮,贴代码、写片段都合适"],
        ["引用 / 配图 / 图表", "blockquote、插图、Mermaid 流程图原生支持"],
      ],
    ),

    b.h(2, "试着上手"),
    b.p("在左侧的对话框里告诉它你想写什么,例如:"),
    b.quote("帮我写一份介绍我们团队的对外简介,语气专业、控制在 300 字以内。"),
    b.p("它会先与你确认要点,再把成稿写到这里。写完不满意?继续追问「第二段再口语一点」即可——它只改你点到的部分。"),

    b.h(2, "完全在本地"),
    b.p("青简桌面端自带服务,文档与对话都存在你本机;模型调用使用你自己的 API Key,数据不经我们的服务器。下面是配置 Key 的示意:"),
    b.code("bash", "# 在设置里填入你自己的模型 API Key\nQINGAGENT_LLM_API_KEY=sk-your-own-key"),
    b.p("准备好了就开始吧——新建一篇空白文档,或直接和它聊两句。"),
  ]);
  const chatHistory = mkChat("seed-welcome", [
    ["user", "青简能帮我做什么?"],
    [
      "agent",
      "你把需求说给我,我来帮你搜资料、列结构、写正文——支持标题、列表、表格、引用、代码、图表,写完还能一键导出 Word / PDF。右边这篇《欢迎使用青简》就是我生成的示例,你可以直接在上面改,或者新建一篇空白文档,跟我聊两句试试。",
    ],
  ]);
  return { id: "seed-welcome", title: "欢迎使用青简", pmDoc, chatHistory, agoMs: 0 };
}

// —— 样例二:对话示例(展示「聊几句 → 出一篇周报」的生成流程) ——
function buildWeeklyDemo(): SeedSample {
  const b = docBuilder("seed-weekly");
  const pmDoc = b.make([
    b.h(1, "本周工作周报"),
    b.h(2, "本周进展"),
    b.ul([
      "完成「连接本地文件夹」数据源接入,支持本地检索与引用",
      "文档导出补齐表格底色与文字色,Word / PDF 样式高保真",
      "首页长卷上线水墨装饰系统,按季节与版式自动铺陈",
    ]),
    b.h(2, "下周计划"),
    b.ul([
      "桌面端首启示例内容(本篇即由该能力生成)联调验收",
      "梳理一轮高频问题,沉淀为回归用例",
    ]),
    b.h(2, "风险与求助"),
    b.p("暂无阻塞;模型 API 配额需在月中前确认续期。"),
  ]);

  const chatHistory = mkChat("seed-weekly", [
    [
      "user",
      "帮我根据这几点写一份本周周报:接入了本地文件夹数据源、导出修了表格样式、首页上了水墨装饰。下周要联调桌面端示例内容、整理回归用例。",
    ],
    [
      "agent",
      "好的。我按「本周进展 / 下周计划 / 风险与求助」三段来组织:你给的三件事归进展,两件归下周计划,再补一条配额风险。现在写到右侧文档。",
    ],
    ["user", "「本周进展」每条后面再补一句量化结果。"],
    [
      "agent",
      "已为三条进展各补了量化(接入文件数、导出格式数、装饰物种数)。要我把整篇导出成 Word 发出去吗?",
    ],
  ]);

  return { id: "seed-weekly-demo", title: "本周工作周报", pmDoc, chatHistory, agoMs: 120_000 };
}

// —— 样例三:科普长文(展示从对话生成有结构的长文 + 多轮改写) ——
function buildScienceDemo(): SeedSample {
  const b = docBuilder("seed-sci");
  const pmDoc = b.make([
    b.h(1, "三分钟看懂量子纠缠"),
    b.p("想象有一副手套被拆成左右两只,分别装进两个一模一样的盒子,一个寄到北京、一个寄到纽约。在你打开任意一个盒子之前,谁也不知道哪只是左、哪只是右;可一旦北京这只被看到是左手,纽约那只在同一刻就「注定」是右手。量子纠缠,某种意义上就是这副神奇的手套。"),

    b.h(2, "它到底是什么"),
    b.p("当两个粒子发生纠缠后,它们会共享同一套「命运」。无论相隔多远,对其中一个的测量结果,都会瞬间决定另一个的状态——这不是信号在传递,而是它们本就是一个整体的两面。"),

    b.h(2, "为什么让人着迷"),
    b.ul([
      "「瞬间」:无论多远,关联都是同时发生的,爱因斯坦称之为「鬼魅般的超距作用」",
      "「不可预知」:单看一个粒子,结果完全随机;只有把两个放在一起,关联才显现",
      "「无法窃听」:任何偷看都会破坏纠缠,这正是量子加密安全的根基",
    ]),

    b.h(2, "它有什么用"),
    b.p("量子纠缠是量子计算与量子通信的基石:它让量子比特能并行表达海量状态,也让「一旦被窃听就必然留痕」的保密通信成为可能。"),

    b.quote("纠缠不是粒子之间在偷偷传话,而是它们从一开始就写好了同一个故事。"),
  ]);

  const chatHistory = mkChat("seed-sci", [
    ["user", "写一篇面向高中生的科普,讲清楚「量子纠缠」,800 字左右,别太学术、少用公式。"],
    [
      "agent",
      "我从一个生活化的比喻切入,分「是什么 / 为什么神奇 / 有什么用」三段来写,控制在 800 字、不用公式。已写到右侧,你看看开头那个比喻合不合适。",
    ],
    ["user", "开头再生动一点。"],
    [
      "agent",
      "把开头换成了「一副被拆散、分寄两地的手套」的比喻,更直观了。要我再配一张示意流程图吗?",
    ],
  ]);

  return { id: "seed-science-demo", title: "三分钟看懂量子纠缠", pmDoc, chatHistory, agoMs: 240_000 };
}

// —— 样例四:竞品对比(展示大表格 + 横向对比 + 选型建议) ——
function buildCompareDemo(): SeedSample {
  const b = docBuilder("seed-cmp");
  const pmDoc = b.make([
    b.h(1, "三款笔记软件选型对比"),
    b.p("围绕个人知识管理的常见诉求,从定位、优点、不足、适合人群四个维度,横向对比 Notion、Obsidian、飞书文档。表格中的任意单元格都可直接编辑。"),
    b.table(
      ["软件", "定位", "优点", "不足", "适合谁"],
      [
        ["Notion", "一体化协作工作区", "模块灵活、模板丰富、团队协作强", "离线弱、大库偏慢", "团队协作 / 重排版"],
        ["Obsidian", "本地优先的双链笔记", "纯本地、双链网络、插件生态大", "上手略陡、协作需自建", "重度个人知识库"],
        ["飞书文档", "办公套件内的文档", "中文体验好、多维表格、审批集成", "绑定飞书生态", "国内团队 / 办公一体"],
      ],
    ),
    b.h(2, "一句话建议"),
    b.p("个人长期沉淀选 Obsidian,团队协作与排版选 Notion,身处国内办公生态选飞书文档。"),
  ]);

  const chatHistory = mkChat("seed-cmp", [
    ["user", "帮我对比 Notion、Obsidian、飞书文档三款,做成表格,最后给一句选型建议。"],
    [
      "agent",
      "已整理成一张对比表,从定位 / 优点 / 不足 / 适合人群四个维度横向对比,并在末尾给了一句选型建议。你可以直接改表格里的任意单元格,或让我再加一列「价格」。",
    ],
  ]);

  return { id: "seed-compare-demo", title: "三款笔记软件选型对比", pmDoc, chatHistory, agoMs: 360_000 };
}

// ⚠️ 首启示例的创建日期必须用「一年多前」的固定日期(2025-04-16),不要用当前时间。
// 原因:这些示例文档会被模型看板的「近 7 天文档 / 用量」统计算进去,用当前时间会让首启就
// 出现虚高的用量数字、误导用户。用一年前的日期,示例天然落在「近 7 天」窗口之外、不计入统计。
// 以后再生成 / 替换这套示例,沿用此规则(一年前的固定日期)。
const SEED_BASE_TS = Date.parse("2025-04-16T09:00:00+08:00");

async function writeSample(sample: SeedSample): Promise<void> {
  const memory = mastra.getMemory("default");
  if (!memory) return;

  const createdAt = new Date(SEED_BASE_TS - sample.agoMs);
  const createdIso = createdAt.toISOString();

  const legacySections = projectPmDocToSections(sample.pmDoc);
  const wordCount = countWords(legacySections);

  // 1) 文档正文 → documents 表(工作区打开时从这里加载 PmDoc)
  await documentRepo.save({
    id: sample.id,
    threadId: sample.id,
    resourceId: QINGAGENT_RESOURCE_ID,
    title: sample.title,
    docState: "editing",
    docVersion: 1,
    lastSyncedVersion: 1,
    legacySections,
    pmDoc: sample.pmDoc,
    createdAt: createdIso,
    updatedAt: createdIso,
  });

  // 2) 会话元数据 → Mastra thread(home 列表卡片 + 会话恢复从这里取)
  const metadata: QingagentThreadMetadata = {
    docId: sample.id,
    docState: { kind: "editing" },
    docVersion: 1,
    lastContentEditedAt: createdIso,
    lastSyncedDocumentSnapshot: 1,
    doc: sample.pmDoc,
    legacySections,
    materials: [],
    folderSources: [],
    title: sample.title,
    runId: null,
    toolCallId: null,
    askUserCompleted: true,
    chatHistory: sample.chatHistory,
    threadSummary: {
      sectionCount: legacySections.length,
      wordCount,
      status: "editing",
      materialCount: 0,
    },
    lastPersistedAt: createdIso,
  };

  await memory.saveThread({
    thread: {
      id: sample.id,
      title: sample.title,
      resourceId: QINGAGENT_RESOURCE_ID,
      createdAt,
      updatedAt: createdAt,
      metadata: metadata as unknown as Record<string, unknown>,
    },
  });
}

/**
 * 往本地库写入示例文章 + 对话。幂等(固定 id,upsert);**不自带 once 门**,
 * 「一辈子只 seed 一次」由调用方(桌面主进程)的持久标记控制。
 */
export async function seedInitialContent(): Promise<void> {
  // documentRepo.save 内部 readyClient() 已确保 documents 表存在,无需额外建表。
  const samples = [
    buildWelcome(),
    buildWeeklyDemo(),
    buildScienceDemo(),
    buildCompareDemo(),
  ];
  for (const s of samples) {
    await writeSample(s);
  }
}
