import type {
  AskUserAnswer,
  AskUserQuestion,
  AskUserSpec,
  CommandCardBody,
  GenerateSvgCardBody,
  ImagePart,
  MessagePart,
  QrCardBody,
  ResearchCardBody,
  ReviewOutcome,
  ToolCallBody,
  ToolCallResult,
  ToolCallSpec,
  ToolCallStatus,
  WriteDraftCardBody,
} from "@qingagent/contract-ts";

// ──────────────────────────────────────────────────────────────────────────
// #/uikit「现役对话组件」一节的 mock 数据。
// 原样取自 #/spec(SpecDemoPage)的真实组件用法,只为驱动 revampUi 里的真实 .u-* 组件,
// 不重写组件、不掺现状对比。
// ──────────────────────────────────────────────────────────────────────────

let _id = 0;
const nid = (p: string) => `${p}-${++_id}`;

export const ST = {
  pending: { kind: "pending" } as ToolCallStatus,
  running: { kind: "running", data: { progressPct: null, etaSec: null } } as ToolCallStatus,
  done: { kind: "done" } as ToolCallStatus,
  aborted: { kind: "aborted" } as ToolCallStatus,
  failed: (r: string): ToolCallStatus => ({ kind: "failed", data: { retriable: true, reason: r } }),
};
export const tool = (
  name: string,
  status: ToolCallStatus,
  body: ToolCallBody,
  result: ToolCallResult | null = null,
): ToolCallSpec => ({ id: nid("t"), name, render: { kind: "chatInline" }, status, body, result });
export const generic = (args: Record<string, unknown>): ToolCallBody => ({
  kind: "generic",
  data: { argsJson: JSON.stringify(args) },
});
export const gres = (o: unknown): ToolCallResult => ({ kind: "genericText", data: JSON.stringify(o) });
export const tp = (spec: ToolCallSpec): MessagePart => ({ kind: "toolCall", data: spec });

export const TINY_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#11161b"/><path d="M16 70 L60 30 L92 56 L120 28 L144 50" fill="none" stroke="#b59a63" stroke-width="2.5"/><circle cx="120" cy="28" r="4" fill="#d8382b"/></svg>',
)}`;

export const researchDone: ResearchCardBody = {
  query: "杭州亚运会 开幕式 亮点",
  phase: "done",
  total: 5,
  fetchedCount: 5,
  okCount: 4,
  skippedCount: 1,
  items: [
    { url: "https://hangzhou2022.cn/a", title: "开幕式十大亮点", status: "done", wordCount: 1820 },
    { url: "https://news.cn/b", title: "数字火炬手背后的技术", status: "done", wordCount: 990 },
  ],
};
export const svgDone: GenerateSvgCardBody = {
  prompt: "杭州亚运会主场馆示意",
  style: "line",
  aspect: "16:9",
  progress: {
    stage: "done",
    elapsedMs: 1500,
    rawKb: 4,
    message: "",
    error: null,
    src: TINY_SVG,
    width: 160,
    height: 90,
    partialSvg: null,
  },
};
export const draftDone: WriteDraftCardBody = {
  title: "杭州亚运会观察",
  phase: "done",
  charCount: 1180,
  excerpt: "本届亚运会的看点不止于金牌，更在于一座城市如何用科技与人文重新讲述自己。",
  targetLength: null,
  minLength: 800,
  maxLength: 1200,
  revisionCount: 0,
  lengthStatus: "accepted_first_pass",
};
export const cmdDone: CommandCardBody = {
  title: "计算字数",
  icon: "🧮",
  command: "wc -m draft.md",
  exitCode: 0,
  outputTail: "1180",
  phase: "done",
};
export const qrData: QrCardBody = {
  content: "https://example.com/auth?code=DEMO",
  title: "扫码授权飞书",
  code: "WXYZ-1234",
  note: "请用飞书 App 扫码，或 [点此授权](https://example.com/auth)",
  expiresAt: 0,
  refreshQuery: "刷新",
  confirmQuery: "我已完成授权",
};
export const askQ: AskUserQuestion[] = [
  {
    id: "q1",
    label: "文章篇幅",
    kind: { kind: "slider" },
    options: [],
    placeholder: null,
    slider: { min: 300, max: 2000, step: 100, unit: "字", marks: null, aboveLabel: "2000 字以上" },
  },
  {
    id: "q2",
    label: "目标读者",
    kind: { kind: "single" },
    options: [{ value: "public", label: "大众读者", description: null, preview: null }],
    placeholder: null,
  },
  { id: "q3", label: "语气", kind: { kind: "text" }, options: [], placeholder: null },
];
export const askA: Record<string, AskUserAnswer | undefined> = {
  q1: { chosen: [], freeText: null, numericValue: 800 },
  q2: { chosen: ["public"], freeText: null },
  q3: { chosen: [], freeText: "专业但不晦涩" },
};

// ──────────────────────────────────────────────────────────────────────────
// 审核回流卡(ReviewOutcomeCard)三态 mock —— 对应「提交(局部采纳)/放弃本轮」后
// 以用户名义回流进 chatHistory 的 reviewOutcome part。计数以 hunks 派生。
// ──────────────────────────────────────────────────────────────────────────
export const reviewMixed: ReviewOutcome = {
  acceptedCount: 2,
  rejectedCount: 1,
  hunks: [
    {
      verdict: "accepted",
      blockSummary: "开头导语",
      beforeText: "本届亚运会看点很多。",
      afterText: "本届亚运会的看点不止于金牌，更在于一座城市如何重新讲述自己。",
    },
    {
      verdict: "accepted",
      blockSummary: "第二段过渡",
      beforeText: "科技应用很广泛。",
      afterText: "科技贯穿赛事全程，从数字火炬到智能场馆。",
    },
    {
      verdict: "rejected",
      blockSummary: "结尾升华",
      beforeText: "总之这届办得很成功。",
      afterText: "这是一场属于城市与时代的盛会。",
    },
  ],
};
export const reviewAllRejected: ReviewOutcome = {
  acceptedCount: 0,
  rejectedCount: 2,
  hunks: [
    { verdict: "rejected", blockSummary: "标题改写", beforeText: "亚运观察", afterText: "亚运会深度观察报道" },
    { verdict: "rejected", blockSummary: "首段重写", beforeText: "开幕式很精彩。", afterText: "开幕式以数字与人文交织，惊艳全场。" },
  ],
};
export const reviewAllAccepted: ReviewOutcome = {
  acceptedCount: 2,
  rejectedCount: 0,
  hunks: [
    { verdict: "accepted", blockSummary: "第一处", beforeText: "旧句一。", afterText: "润色后的新句一。" },
    { verdict: "accepted", blockSummary: "第二处", beforeText: "旧句二。", afterText: "润色后的新句二。" },
  ],
};

// 来源卡(生产 BrowserViewPart 走 image part)——带图 / 无图两态。
export const sourceImageWithThumb: ImagePart = {
  label: "开幕式十大亮点 · 杭州亚运会官网",
  src: TINY_SVG,
  srcKind: "url",
  sourceUrl: "https://hangzhou2022.cn/a",
  width: 160,
  height: 90,
};
export const sourceImageNoThumb: ImagePart = {
  label: "数字火炬手背后的技术",
  src: null,
  srcKind: "url",
  sourceUrl: "https://news.cn/b",
  width: null,
  height: null,
};

// 图表块可视化的 Mermaid 真相源 —— flowchart 走 GraphDiagramView(React Flow),
// sequence 走 MermaidPreview(静态 SVG),覆盖 DiagramRenderer 两条渲染路径。
export const diagramFlowchart = `flowchart TD
  A[选题] -->|确认| B[写作]
  B --> C[审核]
  C -->|通过| D[交付]
`;
export const diagramSequence = `sequenceDiagram
  participant U as 用户
  participant Q as 青简
  U->>Q: 帮我写一篇亚运观察
  Q-->>U: 初稿已完成
`;

// ──────────────────────────────────────────────────────────────────────────
// AskUser 开场问卷(BigPlanPanel)真实渲染用 spec。
// 覆盖四种题型:滑块 slider / 单选 single / 多选 multi(带 description → bp-opt.has-desc)/
// 文字 text。BigPlanPanel 是 AskUser 的 fullpage 形态,右栏渲染,提交 AskUserAnswers。
// ──────────────────────────────────────────────────────────────────────────
export const bigPlanQuestions: AskUserQuestion[] = [
  {
    id: "bp1",
    label: "文章篇幅",
    kind: { kind: "slider" },
    options: [],
    placeholder: null,
    slider: { min: 300, max: 2000, step: 100, unit: "字", marks: null, aboveLabel: "2000 字以上" },
  },
  {
    id: "bp2",
    label: "目标读者",
    kind: { kind: "single" },
    options: [
      { value: "public", label: "大众读者", description: "面向普通网友,通俗易懂", preview: null },
      { value: "pro", label: "行业读者", description: "可用专业术语,重深度", preview: null },
    ],
    placeholder: null,
  },
  {
    id: "bp3",
    label: "希望覆盖的角度(可多选)",
    kind: { kind: "multi" },
    options: [
      { value: "tech", label: "科技应用", description: null, preview: null },
      { value: "humanity", label: "人文故事", description: null, preview: null },
      { value: "city", label: "城市形象", description: null, preview: null },
    ],
    placeholder: null,
  },
  { id: "bp4", label: "语气偏好", kind: { kind: "text" }, options: [], placeholder: "例如:专业但不晦涩" },
];
export const bigPlanSpec: AskUserSpec = {
  id: "bp-spec-uikit",
  mode: { kind: "fullpage" },
  purpose: null,
  source: "动笔之前,先聊几句",
  rationale: "先确认几个方向,写出来更贴近你的需求。",
  questions: bigPlanQuestions,
};

// askUserQuestion overlay 真组件：首题覆盖 header chips、说明卡与 markdown/mermaid preview；
// 后续题覆盖无 preview 胶囊、多选补充输入和共享 aus2 滑块，可在展厅直接点题签走查。
export const askUserQuestionOverlaySpec: AskUserSpec = {
  id: "ask-user-question-uikit",
  mode: { kind: "overlay" },
  purpose: null,
  source: null,
  rationale: "选择最接近的方向；样张会随悬停或选中项切换。",
  questions: [
    {
      id: "auq-style",
      header: "文风",
      label: "你希望文章偏向哪种风格？",
      kind: { kind: "single" },
      options: [
        {
          value: "popular",
          label: "通俗科普",
          description: "用生活化语言解释技术原理，面向大众读者",
          preview: "## AI 正在学会「读心」？\n其实背后没有魔法，它只是更善于理解上下文。\n\n```mermaid\nflowchart LR\n  A[提问] --> B[理解语境]\n  B --> C[清晰回答]\n```\n\n> 把复杂的事讲简单，是这种文风的骨架。",
        },
        {
          value: "structure",
          label: "结构示意",
          description: "用流程图预览文章的论证推进关系",
          preview: "```mermaid\nflowchart LR\n  A[现象] --> B[分析]\n  B --> C[结论]\n```",
        },
      ],
      placeholder: null,
    },
    {
      id: "auq-points",
      header: "要点",
      label: "内容里还想强化哪些元素？",
      kind: { kind: "multi" },
      options: [
        { value: "data", label: "数据图表", description: null, preview: null },
        { value: "case", label: "案例故事", description: null, preview: null },
        { value: "action", label: "行动清单", description: null, preview: null },
      ],
      placeholder: null,
    },
    {
      id: "auq-length",
      header: "篇幅",
      label: "目标篇幅",
      kind: { kind: "slider" },
      options: [],
      placeholder: null,
      slider: {
        min: 300,
        max: 2000,
        step: 100,
        unit: "字",
        marks: [300, 800, 1400, 2000],
        aboveLabel: "2000 字以上",
      },
    },
  ],
};

// 轮级折叠的过程 parts(一段真实工作流)
export const processParts: MessagePart[] = [
  { kind: "thinking", data: { id: nid("th"), steps: ["先读素材，再确认方向，然后写。"] } },
  tp(tool("parseFile", ST.done, generic({ filePath: "/uploads/赛事手册.pdf" }), gres({ wordCount: 8200 }))),
  tp(tool("readMaterial", ST.done, generic({ mode: "summary", materialId: "赛事手册" }))),
  tp(
    tool(
      "askUser",
      ST.done,
      { kind: "askUser", data: { id: nid("a"), mode: { kind: "fullpage" }, purpose: null, source: null, rationale: null, questions: askQ } },
      { kind: "askUserAnswers", data: askA },
    ),
  ),
  tp(tool("webSearch", ST.done, { kind: "researchCard", data: researchDone })),
  tp(tool("writeDraft", ST.done, { kind: "writeDraftCard", data: draftDone })),
  tp(tool("generateSvg", ST.done, { kind: "generateSvg", data: svgDone })),
  { kind: "patchSummary", data: { count: 2, hunkIds: ["h"] } },
  tp(tool("mastra_workspace_write_file", ST.done, generic({ path: "/work/cover.svg" }), gres({ bytes: 2048 }))),
];
