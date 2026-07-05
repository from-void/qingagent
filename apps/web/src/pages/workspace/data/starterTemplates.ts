// 新建即编辑 · 空引导态的模板数据(推荐 tab 按行业分组)。
// 模板从纯章节标题升级为结构化 blocks:填充后是真骨架,每节都有可继续改写的正文或要点。
import { aiIrToPm, type AiBlock, type AiDocument, type PmDoc } from "@qingagent/pm-schema";

export type StarterTemplateBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bulletList"; items: string[] }
  | { type: "orderedList"; items: string[] }
  | { type: "taskList"; items: Array<{ text: string; checked?: boolean }> }
  | { type: "table"; rows: StarterTemplateTableRow[] };

export type StarterTemplateTableCell = {
  text: string;
  header?: boolean;
};

export type StarterTemplateTableRow = {
  cells: StarterTemplateTableCell[];
};

export interface StarterTemplate {
  /** 全局唯一 id(收藏以此为键,跨文档持久化) */
  id: string;
  /** 模板名(中文) */
  name: string;
  /** 一行简述 */
  desc: string;
  /** 文档骨架 blocks:首个 heading(1) 作为文档标题,其余为正文骨架 */
  blocks: StarterTemplateBlock[];
}

export interface StarterIndustry {
  id: string;
  name: string;
  templates: StarterTemplate[];
}

type SectionInput = {
  title: string;
  body: string;
  bullets?: string[];
};

const h = (
  level: Extract<StarterTemplateBlock, { type: "heading" }>["level"],
  text: string,
): StarterTemplateBlock => ({
  type: "heading",
  level,
  text,
});
const p = (text: string): StarterTemplateBlock => ({ type: "paragraph", text });
const ul = (items: string[]): StarterTemplateBlock => ({ type: "bulletList", items });
const ol = (items: string[]): StarterTemplateBlock => ({ type: "orderedList", items });
const tasks = (items: Array<{ text: string; checked?: boolean }>): StarterTemplateBlock => ({
  type: "taskList",
  items,
});
const table = (rows: StarterTemplateTableRow[]): StarterTemplateBlock => ({ type: "table", rows });

function section(title: string, body: string, bullets?: string[]): SectionInput {
  return { title, body, bullets };
}

function defaultSectionBullets(s: SectionInput): string[] {
  return [
    `${s.title}:补充事实依据、样本来源和当前判断,避免只写结论。`,
    `输出物:把 ${s.body} 落成可评审、可交付、可追踪的内容。`,
    "边界:写明暂不覆盖的范围、假设条件和需要继续验证的问题。",
  ];
}

function sectionBullets(s: SectionInput): string[] {
  return s.bullets && s.bullets.length > 0 ? s.bullets : defaultSectionBullets(s);
}

function sectionBody(templateName: string, s: SectionInput): string {
  return `${s.body} 写作时建议先给出结论,再补充证据、判断口径和下一步动作;如果涉及数据,需写清时间范围、统计口径、样本来源和负责角色,让「${templateName}」能直接进入评审、执行或复盘流程。`;
}

function overviewParagraph(name: string, desc: string, sections: SectionInput[]): string {
  const sectionNames = sections.map((s) => s.title).join("、");
  return `这份「${name}」用于沉淀${desc},建议按「${sectionNames}」推进。正文保留可直接改写的判断、证据、表格和行动项,先把关键事实写实,再补充负责人、时间、指标与风险,避免停留在空泛提纲。`;
}

function summaryRows(sections: SectionInput[]): StarterTemplateTableRow[] {
  return [
    { cells: [{ text: "模块", header: true }, { text: "需要回答的问题", header: true }, { text: "建议交付物", header: true }] },
    ...sections.slice(0, 5).map((s) => ({
      cells: [
        { text: s.title },
        { text: s.body },
        { text: `${s.title}结论、证据、负责人和截止时间` },
      ],
    })),
  ];
}

function riskRows(sections: SectionInput[]): StarterTemplateTableRow[] {
  return [
    { cells: [{ text: "风险点", header: true }, { text: "观察信号", header: true }, { text: "兜底动作", header: true }] },
    ...sections.slice(0, 4).map((s, index) => ({
      cells: [
        { text: `${s.title}信息不足` },
        { text: index % 2 === 0 ? "评审反复追问口径、数据或责任边界" : "执行中出现依赖延期、范围扩大或结果不可验收" },
        { text: `补齐${s.title}的证据、排期和验收标准` },
      ],
    })),
  ];
}

function sectionBlocks(name: string, sectionInput: SectionInput, index: number): StarterTemplateBlock[] {
  const bullets = sectionBullets(sectionInput);
  return [
    h(2, sectionInput.title),
    p(sectionBody(name, sectionInput)),
    index % 2 === 0 ? ul(bullets) : ol(bullets),
    h(3, `${sectionInput.title}检查点`),
    tasks([
      { checked: false, text: `补齐「${sectionInput.title}」的背景材料和原始证据。` },
      { checked: false, text: `确认「${sectionInput.title}」的负责人、截止时间和验收口径。` },
      { checked: false, text: `把争议、风险或待确认问题记录到后续行动清单。` },
    ]),
  ];
}

function closingBlocks(name: string, sections: SectionInput[]): StarterTemplateBlock[] {
  return [
    h(2, "总览表"),
    table(summaryRows(sections)),
    h(2, "风险与推进"),
    table(riskRows(sections)),
    h(2, "下一步待办"),
    tasks(sections.slice(0, 5).map((s) => ({
      checked: false,
      text: `完善「${s.title}」并同步给相关协作者确认。`,
    }))),
    p(`完成「${name}」后,建议统一检查标题、结论、数据口径、表格内容和待办负责人,再决定是否进入评审、发布、汇报或归档。`),
  ];
}

function tpl(
  id: string,
  name: string,
  desc: string,
  title: string,
  sections: SectionInput[],
): StarterTemplate {
  return {
    id,
    name,
    desc,
    blocks: [
      h(1, title),
      p(overviewParagraph(name, desc, sections)),
      ...sections.flatMap((s, index) => sectionBlocks(name, s, index)),
      ...closingBlocks(name, sections),
    ],
  };
}

// 行业 6 类(写作场景),每类 5 个高频模板。
export const STARTER_INDUSTRIES: StarterIndustry[] = [
  {
    id: "internet",
    name: "互联网产品",
    templates: [
      tpl("prd", "产品需求文档", "背景目标与功能规划", "产品需求文档", [
        section("背景与目标", "说明需求来自哪个业务问题、当前指标缺口和本次迭代希望带来的可验证变化。", [
          "业务背景:当前流程、数据或用户反馈中的主要矛盾。",
          "目标指标:转化率、留存、效率、成本或满意度的目标口径。",
          "非目标:本期明确不解决的范围,防止评审发散。",
        ]),
        section("用户故事", "把目标用户、触发场景、完成动作和预期收益写成可验证的故事,方便后续拆功能。", [
          "作为目标用户,我希望在某个场景下完成某件事。",
          "我当前遇到的阻塞是哪些信息、步骤或反馈不足。",
          "完成后我能获得的价值与平台能获得的价值。",
        ]),
        section("功能清单", "按主流程、辅助能力和后台配置拆分功能,每项都写清输入、处理和输出。", [
          "核心流程:用户从入口到完成任务的最短路径。",
          "状态反馈:加载、成功、失败、空态、权限不足等反馈。",
          "管理配置:运营、客服、审核或后台需要的控制项。",
        ]),
        section("验收标准", "用可测试的条件描述上线标准,覆盖正常路径、异常路径和数据埋点。", [
          "功能验收:给定条件下用户能完成目标动作。",
          "数据验收:关键事件、属性和看板口径已经就绪。",
          "质量验收:性能、兼容性、安全和降级策略达标。",
        ]),
        section("风险与排期", "列出依赖、灰度、回滚和里程碑,让实现团队能据此估算并控制风险。", [
          "关键依赖:接口、数据、设计、法务或第三方服务。",
          "灰度策略:放量范围、观察指标和停止条件。",
          "排期节点:设计评审、开发联调、测试验收、上线复盘。",
        ]),
      ]),
      tpl("competitor", "竞品分析报告", "竞品对比与差异化", "竞品分析报告", [
        section("分析范围", "界定本次分析的问题、目标用户、竞品池和资料来源,避免泛泛罗列功能截图。", [
          "直接竞品:目标用户和核心场景高度重合的产品。",
          "间接竞品:解决同一用户问题但路径不同的替代方案。",
          "资料来源:官网、应用商店、公开报道、体验账号和用户评价。",
        ]),
        section("竞品矩阵", "用统一维度对比核心定位、目标客群、收费模式和关键能力,先建立全局判断。", [
          "定位与承诺:竞品对用户说自己解决什么问题。",
          "关键能力:每个竞品最强和最弱的产品能力。",
          "商业模式:免费、订阅、交易抽佣或企业采购等路径。",
        ]),
        section("关键流程对比", "选择一个最重要的用户任务,逐步对比入口、步骤、反馈和完成成本。", [
          "入口发现:用户从哪里开始,是否需要学习成本。",
          "路径效率:完成任务需要几步、是否有中断和回退。",
          "结果反馈:完成后是否清楚、可追踪、可再次行动。",
        ]),
        section("差异化机会", "把竞品优势和用户不满转成可执行机会,不要停留在主观评价。", [
          "可借鉴:已经被市场验证且适合本产品的做法。",
          "可避开:竞品复杂、昂贵或体验割裂的地方。",
          "可领先:结合自身数据、渠道或技术形成的独特能力。",
        ]),
        section("结论与建议", "给出优先级、验证方式和下一步行动,让报告能直接进入需求池。", [
          "短期:一到两个低成本高确定性的优化点。",
          "中期:需要跨团队投入的差异化能力。",
          "验证:访谈、灰度实验或数据回看如何确认判断。",
        ]),
      ]),
      tpl("user-research", "用户调研报告", "访谈洞察与结论", "用户调研报告", [
        section("调研目标", "说明要验证的假设、业务决策和本次调研不会回答的问题。", [
          "核心问题:用户为什么在当前环节停下或流失。",
          "决策用途:结果将影响需求优先级、信息架构或商业策略。",
          "边界:本次不覆盖的人群、场景和量化结论。",
        ]),
        section("方法与样本", "记录招募方式、样本结构、访谈脚本和分析方法,保证结论可追溯。", [
          "样本分层:新用户、活跃用户、流失用户或高价值用户。",
          "研究方法:深访、可用性测试、问卷或日志分析。",
          "质量控制:录音、转写、双人编码和异常样本剔除。",
        ]),
        section("关键洞察", "把原始反馈归纳为行为模式和动机,每条洞察都配上证据。", [
          "用户目标:他们真正想完成的任务和衡量成功的方式。",
          "阻塞原因:信息缺失、信任不足、流程太长或收益不清。",
          "替代方案:用户现在如何绕过产品完成同类任务。",
        ]),
        section("机会点", "将洞察转成产品机会,写清价值、复杂度和优先级判断。", [
          "高价值机会:直接影响核心指标或高频场景。",
          "体验补洞:成本低但能减少困惑和误操作的优化。",
          "待验证问题:证据不足但值得继续实验的方向。",
        ]),
        section("结论与建议", "收束成可行动建议,明确负责人、验证指标和预计节奏。", [
          "需求建议:进入近期需求池的具体改动。",
          "实验建议:需要 A/B 或灰度验证的假设。",
          "后续研究:下一轮应覆盖的人群和问题。",
        ]),
      ]),
      tpl("review-notes", "需求评审纪要", "评审结论与待办", "需求评审纪要", [
        section("评审范围", "写明本次评审的需求版本、参会角色和需要拍板的议题。", [
          "需求版本:PRD 链接、设计稿版本和接口草案。",
          "参会角色:产品、设计、研发、测试、运营或法务。",
          "决策议题:本次必须达成一致的范围、方案和排期。",
        ]),
        section("讨论要点", "按议题记录关键争议、证据和取舍,不要只写结论。", [
          "用户价值:该功能是否解决高优先级问题。",
          "实现成本:复杂点、技术债和跨端一致性。",
          "上线风险:数据、权限、合规、回滚和客服预案。",
        ]),
        section("评审结论", "把达成一致的方案、暂缓项和需要补充验证的事项分开写清。", [
          "确认上线:本期纳入开发的范围。",
          "调整后上线:需要产品或设计补充的信息。",
          "暂缓:原因、触发条件和后续回看时间。",
        ]),
        section("待办与负责人", "每个 action item 都要有负责人、交付物和截止时间,方便会后追踪。", [
          "产品:补充规则、埋点、验收标准或 FAQ。",
          "设计:补齐状态、动效、异常流和适配方案。",
          "研发/测试:确认技术方案、排期和测试范围。",
        ]),
        section("风险记录", "记录评审中尚未完全关闭的风险,并明确观察指标或兜底方案。", [
          "体验风险:用户误解、路径变长或信息过载。",
          "技术风险:性能、兼容性、数据一致性或第三方依赖。",
          "运营风险:灰度、客服话术、公告和回滚。",
        ]),
      ]),
      tpl("feature-spec", "功能规格说明", "功能逻辑与边界", "功能规格说明", [
        section("功能概述", "概括功能目的、用户入口、适用版本和与现有能力的关系。", [
          "目标用户:哪些角色能看到并使用该功能。",
          "入口位置:导航、按钮、快捷操作或系统触发。",
          "版本范围:端、地区、灰度人群和权限条件。",
        ]),
        section("交互流程", "按用户动作展开主流程,写清每一步的页面、输入、输出和反馈。", [
          "起始状态:用户进入功能前看到什么。",
          "关键动作:用户需要选择、填写、确认或撤销的内容。",
          "完成状态:成功提示、后续入口和可追踪结果。",
        ]),
        section("规则与边界", "把业务规则、限制条件和异常处理写成研发可实现、测试可覆盖的条目。", [
          "权限规则:谁能读、写、审批或导出。",
          "数据规则:字段校验、默认值、去重和保留周期。",
          "异常规则:失败重试、降级、冲突和空数据处理。",
        ]),
        section("埋点与指标", "列出关键事件、属性和分析口径,保证上线后能判断功能是否有效。", [
          "漏斗事件:曝光、点击、提交、成功、失败。",
          "质量事件:错误码、耗时、重试和取消。",
          "核心指标:转化、留存、效率或成本改善。",
        ]),
        section("依赖与影响", "说明上下游接口、历史数据、运营配置和用户迁移成本。", [
          "接口依赖:新增、变更或废弃的 API。",
          "数据依赖:存量数据迁移、兼容和回填。",
          "协同影响:客服、运营、风控、财务或销售动作。",
        ]),
      ]),
    ],
  },
  {
    id: "marketing",
    name: "市场营销",
    templates: [
      tpl("campaign", "营销活动策划", "目标人群与执行节奏", "营销活动策划", [
        section("活动目标", "写清本次活动服务的业务阶段、核心指标和成功标准,让创意和投放都围绕同一目标展开。"),
        section("目标人群", "描述目标人群的需求、触发时机和决策阻碍,并说明为什么现在适合触达。"),
        section("玩法与节奏", "拆分预热、爆发、延续和复盘阶段,说明每阶段用户看到什么、做什么、获得什么。"),
        section("渠道组合", "列出自有渠道、付费渠道、合作渠道和内容阵地的分工,避免所有渠道说同一套话。"),
        section("预算与排期", "把预算、资源、关键物料和上线节点写成可追踪计划,并预留调整窗口。"),
      ]),
      tpl("brand-promo", "品牌推广方案", "定位与传播策略", "品牌推广方案", [
        section("品牌定位", "概括品牌要占据的心智、目标人群和差异化理由,避免只堆形容词。"),
        section("传播主题", "把定位翻译成一句主张、三个支撑点和可延展的内容表达方向。"),
        section("渠道策略", "说明不同渠道承担认知、兴趣、转化或复购中的哪一环,并匹配内容形态。"),
        section("执行计划", "列出关键物料、发布时间、协作角色和审核节点,保证传播节奏稳定。"),
        section("效果衡量", "定义声量、互动、线索、转化和品牌搜索等指标,并写清复盘口径。"),
      ]),
      tpl("market-research", "市场调研报告", "市场规模与机会", "市场调研报告", [
        section("研究背景", "说明为什么要研究该市场、当前业务面临的判断题和需要支持的决策。"),
        section("市场规模", "拆分总体规模、增长速度、细分赛道和关键驱动因素,标注数据来源。"),
        section("竞争格局", "描述主要玩家、份额变化、商业模式和进入壁垒,突出结构性机会。"),
        section("用户需求", "归纳目标客户的高频场景、支付意愿和未被满足的痛点。"),
        section("机会与建议", "把市场判断转成进入策略、优先细分人群和下一步验证动作。"),
      ]),
      tpl("content-topic", "新媒体选题", "选题方向与排期", "新媒体选题", [
        section("账号定位", "写清账号服务的人群、价值承诺和内容边界,保证选题长期一致。"),
        section("选题方向", "围绕痛点、热点、案例、教程和观点建立选题池,每类给出判断标准。"),
        section("内容结构", "为不同选题定义标题、开头、主体、案例和结尾互动的基本写法。"),
        section("发布排期", "按周或月安排主题、渠道、负责人和素材来源,避免临时追热点。"),
        section("数据目标", "定义阅读、完播、互动、转化和收藏等指标,并写清复盘后的迭代方式。"),
      ]),
      tpl("ad-review", "投放复盘", "数据表现与优化", "投放复盘", [
        section("投放概况", "记录投放周期、渠道、预算、素材数量和目标人群,为数据解读提供背景。"),
        section("数据表现", "按曝光、点击、转化、成本和 ROI 展开,区分渠道表现与素材表现。"),
        section("问题诊断", "从人群、素材、落地页、出价和时段定位异常点,避免只看单一指标。"),
        section("优化方向", "提出下一轮预算调整、素材迭代、人群拓展和落地页改造建议。"),
        section("经验沉淀", "总结可复用的受众、卖点、视觉和节奏,形成后续投放的基础规则。"),
      ]),
    ],
  },
  {
    id: "workplace",
    name: "职场办公",
    templates: [
      tpl("weekly", "工作周报", "本周进展与下周计划", "工作周报", [
        section("本周进展", "按目标或项目列出已完成事项,补充结果数据和实际影响,不要只写忙了什么。"),
        section("问题与风险", "说明当前阻塞、风险等级、已采取动作和需要谁协助解决。"),
        section("下周计划", "写清下周优先事项、交付物和预计完成时间,让协作者能提前对齐。"),
        section("需协调事项", "列出跨团队依赖、决策请求和资源需求,并标注期望反馈时间。"),
      ]),
      tpl("summary", "工作总结", "成果复盘与改进", "工作总结", [
        section("目标回顾", "回到周期初设定的目标和衡量口径,说明哪些目标完成、哪些发生变化。"),
        section("主要成果", "用数据、交付物和业务影响证明成果,突出最有代表性的几项。"),
        section("不足与反思", "分析未达成的原因、过程中的判断偏差和可改进的工作方式。"),
        section("经验沉淀", "提炼可复用的方法、流程或模板,方便团队下一次直接使用。"),
        section("下阶段计划", "把反思转成下一阶段目标、优先级和具体行动。"),
      ]),
      tpl("meeting-notes", "会议纪要", "决议与待办", "会议纪要", [
        section("会议信息", "记录时间、参会人、背景材料和会议目标,方便未参会同事快速理解上下文。"),
        section("讨论要点", "按议题归纳讨论内容、分歧和依据,保留影响决策的关键信息。"),
        section("决议事项", "写清已经拍板的结论、适用范围和后续执行原则。"),
        section("待办与负责人", "每个待办都要包含负责人、交付物、截止时间和验收方式。"),
      ]),
      tpl("project-plan", "项目计划", "里程碑与分工", "项目计划", [
        section("项目目标", "说明项目要解决的问题、目标收益和衡量指标,让所有分工围绕同一目标。"),
        section("范围与边界", "列出本期包含、不包含和待确认内容,降低执行过程中的范围膨胀。"),
        section("里程碑", "按阶段写出关键节点、交付物和验收条件,方便跟踪进度。"),
        section("任务分工", "将工作拆到团队或个人,明确接口人、依赖和交付标准。"),
        section("风险预案", "提前识别资源、技术、外部依赖和排期风险,并给出兜底动作。"),
      ]),
      tpl("report-job", "述职报告", "业绩与规划", "述职报告", [
        section("岗位职责", "概括岗位目标、负责范围和关键协作对象,为后续成果建立评价背景。"),
        section("工作业绩", "用指标、项目和影响力呈现核心贡献,突出与职责最相关的成果。"),
        section("能力成长", "说明在专业能力、协作方式和问题解决上的成长,最好配具体案例。"),
        section("问题反思", "客观写出不足、原因和已经开始调整的做法,体现复盘能力。"),
        section("未来规划", "提出下一周期目标、关键项目和需要组织支持的资源。"),
      ]),
    ],
  },
  {
    id: "creator",
    name: "自媒体创作",
    templates: [
      tpl("wechat-article", "公众号文章", "选题与正文结构", "公众号文章", [
        section("标题与导语", "用明确利益点或冲突感吸引读者,导语快速交代为什么这篇值得读。"),
        section("核心观点", "先给出文章主张,再解释这个观点解决了读者的哪类困惑。"),
        section("案例展开", "选择一个具体案例拆解过程、细节和转折,让观点有可感知的证据。"),
        section("方法总结", "把案例沉淀成步骤、清单或判断标准,方便读者带走。"),
        section("结尾与互动", "收束观点并设置一个容易回答的问题,引导评论、收藏或转发。"),
      ]),
      tpl("short-video", "短视频脚本", "钩子与分镜", "短视频脚本", [
        section("开头钩子", "前三秒抛出冲突、结果或反常识判断,让观众知道继续看的理由。"),
        section("内容主体", "按一条主线展开信息,每个段落只解决一个小问题,避免节奏散。"),
        section("分镜脚本", "写清画面、台词、字幕、音效和转场,方便拍摄与剪辑直接执行。"),
        section("情绪节奏", "安排停顿、反转、强调和视觉变化,让信息密度与观看疲劳保持平衡。"),
        section("结尾引导", "用一句明确行动引导关注、评论、私信或跳转,不要同时塞太多指令。"),
      ]),
      tpl("topic-plan", "选题策划", "方向与卖点", "选题策划", [
        section("受众画像", "说明目标读者的身份、压力、愿望和常见误区,让选题从用户出发。"),
        section("选题方向", "按热点借势、问题解答、案例复盘和观点表达建立候选池。"),
        section("差异化卖点", "写出同类内容已经很多时,本账号能提供的新角度、新案例或新表达。"),
        section("内容形态", "为图文、视频、直播或社群内容选择最合适的表达形式。"),
        section("发布计划", "安排发布频率、测试周期和复盘指标,让选题能持续迭代。"),
      ]),
      tpl("hit-teardown", "爆款拆解", "结构与可复用点", "爆款拆解", [
        section("案例概况", "记录内容主题、发布时间、平台、数据表现和目标受众。"),
        section("结构拆解", "分解标题、开头、主体、转折、结尾和互动设计,看清爆点来自哪里。"),
        section("亮点分析", "分析选题、情绪、视觉、叙事和传播机制中的可学习之处。"),
        section("可复用方法", "提炼成自己的选题公式、脚本模板或视觉规则,避免只做欣赏。"),
        section("改写方向", "说明如何结合账号定位做二次创作,避免抄袭和同质化。"),
      ]),
      tpl("content-calendar", "内容日历", "主题与排期", "内容日历", [
        section("整体节奏", "确定月度主题、更新频率和重点节点,让内容有持续感。"),
        section("主题规划", "把内容拆成固定栏目、热点响应和重点专题,平衡稳定与灵活。"),
        section("每周排期", "列出每周标题方向、负责人、素材状态和发布时间。"),
        section("素材准备", "提前收集案例、图片、采访和数据,减少临近发布的赶工。"),
        section("复盘机制", "按周期记录数据、评论和转化,决定保留、优化或停止哪些栏目。"),
      ]),
    ],
  },
  {
    id: "academic",
    name: "学术研究",
    templates: [
      tpl("paper-outline", "论文大纲", "论点与章节结构", "论文大纲", [
        section("研究问题", "清楚提出论文要回答的问题、研究对象和核心概念定义。"),
        section("文献基础", "归纳已有研究的主要脉络、代表观点和仍未解决的空白。"),
        section("研究方法", "说明资料来源、样本、变量、分析方法或论证路径。"),
        section("章节安排", "按逻辑推进列出各章任务,每章都要服务于总论点。"),
        section("预期贡献", "说明论文可能在理论、方法、材料或实践上的增量价值。"),
      ]),
      tpl("lit-review", "文献综述", "脉络与述评", "文献综述", [
        section("综述范围", "界定时间范围、学科边界、关键词和纳入排除标准。"),
        section("研究脉络", "按主题、方法或时间线整理已有研究的发展过程。"),
        section("主要争论", "呈现不同学者的观点差异、证据基础和未决问题。"),
        section("方法评价", "评估常用研究方法的优势、限制和适用条件。"),
        section("述评与展望", "指出现有研究空白,并提出后续研究可推进的方向。"),
      ]),
      tpl("proposal", "开题报告", "选题与可行性", "开题报告", [
        section("选题依据", "说明选题来源、研究意义、现实背景和学术价值。"),
        section("研究内容", "拆分主要问题、核心概念和拟解决的关键环节。"),
        section("研究方法", "写清资料收集、分析框架、实验或调查设计。"),
        section("创新点", "说明与已有研究相比的材料、视角、方法或结论增量。"),
        section("可行性分析", "评估资料、时间、技术条件和风险,提出具体保障措施。"),
      ]),
      tpl("research-plan", "研究计划", "目标与时间表", "研究计划", [
        section("研究目标", "明确总目标、阶段性目标和最终交付成果。"),
        section("技术路线", "描述从资料获取、数据处理到分析验证的整体路径。"),
        section("时间安排", "按阶段列出文献、数据、分析、写作和修改的节点。"),
        section("资源需求", "说明需要的数据、设备、经费、访谈对象或协作支持。"),
        section("预期成果", "写出论文、报告、数据集、工具或会议投稿等成果形式。"),
      ]),
      tpl("experiment", "实验报告", "方法与结果", "实验报告", [
        section("实验目的", "说明实验要验证的假设、变量关系和判断标准。"),
        section("材料与方法", "记录实验材料、设备、步骤、样本和控制条件。"),
        section("结果呈现", "用图表、统计值或观察记录展示结果,并注明异常数据。"),
        section("结果分析", "解释结果是否支持假设,分析误差来源和可能机制。"),
        section("结论", "总结主要发现、局限和后续实验建议。"),
      ]),
    ],
  },
  {
    id: "startup",
    name: "商业创业",
    templates: [
      tpl("bp", "商业计划书", "问题方案与模式", "商业计划书", [
        section("问题与机会", "说明目标客户面临的高频痛点、现有替代方案和市场窗口。"),
        section("解决方案", "描述产品如何解决问题、关键能力是什么、为什么现在可行。"),
        section("商业模式", "写清客户、定价、收入来源、成本结构和单位经济模型假设。"),
        section("增长策略", "说明获客渠道、转化路径、留存机制和规模化节奏。"),
        section("团队与融资", "介绍团队优势、当前进展、资金需求和资金用途。"),
      ]),
      tpl("market-analysis", "市场分析", "规模与竞争", "市场分析", [
        section("市场规模", "拆分 TAM、SAM、SOM 或可服务市场,标注关键假设和数据来源。"),
        section("目标客群", "定义最先切入的客户类型、购买动机和预算来源。"),
        section("竞争格局", "分析直接竞争、替代方案、进入壁垒和差异化空间。"),
        section("趋势判断", "说明政策、技术、渠道或消费习惯变化带来的机会。"),
        section("进入策略", "提出切入场景、首批客户、验证指标和风险控制。"),
      ]),
      tpl("pitch", "融资路演", "亮点与数据", "融资路演", [
        section("项目亮点", "用一句话说明公司做什么、为谁创造价值和为什么值得关注。"),
        section("市场与痛点", "展示目标市场规模、增长逻辑和客户未被满足的关键问题。"),
        section("产品与数据", "说明产品形态、核心壁垒、当前用户或收入数据。"),
        section("商业模式", "讲清付费方、定价、毛利、复购和规模化路径。"),
        section("融资计划", "写明融资金额、出让比例、资金用途和下一阶段里程碑。"),
      ]),
      tpl("biz-model", "商业模式", "价值与盈利", "商业模式", [
        section("价值主张", "明确为客户解决什么问题、带来什么可量化收益。"),
        section("客户与渠道", "描述客户细分、触达方式、销售周期和关键决策人。"),
        section("收入来源", "列出订阅、交易、服务、硬件或广告等收入方式及占比假设。"),
        section("成本结构", "拆解固定成本、变动成本、获客成本和履约成本。"),
        section("关键指标", "定义毛利、回本周期、留存、复购和现金流等经营指标。"),
      ]),
      tpl("project-proposal", "项目方案", "目标与落地", "项目方案", [
        section("项目背景", "说明项目来源、客户或业务诉求、现状问题和机会点。"),
        section("方案设计", "描述整体思路、核心模块、实施路径和关键取舍。"),
        section("落地计划", "列出阶段、里程碑、资源配置和协作机制。"),
        section("收益评估", "估算收入、效率、成本、品牌或战略价值,并说明计算假设。"),
        section("风险与保障", "识别交付、预算、客户、技术和合规风险,提出保障措施。"),
      ]),
    ],
  },
];

/** 按全局 id 查模板(收藏 tab 用 id 还原模板对象) */
export function findStarterTemplate(id: string): StarterTemplate | undefined {
  for (const ind of STARTER_INDUSTRIES) {
    const t = ind.templates.find((t) => t.id === id);
    if (t) return t;
  }
  return undefined;
}

function templateBlockToAiBlock(block: StarterTemplateBlock): AiBlock {
  switch (block.type) {
    case "heading":
      return { type: "heading", level: block.level, runs: [{ text: block.text }] };
    case "paragraph":
      return { type: "paragraph", runs: [{ text: block.text }] };
    case "bulletList":
      return {
        type: "bulletList",
        items: block.items.map((item) => ({ runs: [{ text: item }] })),
      };
    case "orderedList":
      return {
        type: "orderedList",
        items: block.items.map((item) => ({ runs: [{ text: item }] })),
      };
    case "taskList":
      return {
        type: "taskList",
        items: block.items.map((item) => ({
          checked: item.checked ?? false,
          runs: [{ text: item.text }],
        })),
      };
    case "table":
      return {
        type: "table",
        rows: block.rows.map((row) => ({
          cells: row.cells.map((cell) => ({
            runs: [{ text: cell.text }],
            ...(cell.header ? { header: true } : {}),
          })),
        })),
      };
  }
}

/**
 * 把模板 blocks 编译成文档骨架:走 AI-IR → ProseMirror,产出合法 PmDoc。
 * blockId 等由编译器补齐,保证和 AI 生成文档使用同一套 schema 入口。
 */
export function buildTemplateSkeleton(t: StarterTemplate): PmDoc {
  const doc: AiDocument = { title: null, blocks: t.blocks.map(templateBlockToAiBlock) };
  return aiIrToPm(doc);
}
