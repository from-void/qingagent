import type { ReactNode } from "react";
import type {
  AskUserAnswer,
  AskUserQuestion,
  CommandCardBody,
  GenerateSvgCardBody,
  MessagePart,
  QrCardBody,
  ResearchCardBody,
  ToolCallBody,
  ToolCallResult,
  ToolCallSpec,
  ToolCallStatus,
  WriteDraftCardBody,
} from "@qingagent/contract-ts";
import {
  UAskUser,
  UCitation,
  UCommand,
  UDraft,
  UPatch,
  UQr,
  UResearch,
  USource,
  USvg,
  UToolBar,
  UTurnFold,
} from "./revampUi";
import "../workspace/workspace.css";
import "../workspace/workspace-ink-skin.css";
import "./specDemo.css";

// ──────────────────────────────────────────────────────────────────────────
// 最终设计 demo(#/spec):只展示「统一后的对话工具元素」最终样式,供拍板。
// 全部用统一 .u-* 组件(revampUi),不掺现状对比、不碰生产代码。
// ──────────────────────────────────────────────────────────────────────────

let _id = 0;
const nid = (p: string) => `${p}-${++_id}`;
const ST = {
  pending: { kind: "pending" } as ToolCallStatus,
  running: { kind: "running", data: { progressPct: null, etaSec: null } } as ToolCallStatus,
  done: { kind: "done" } as ToolCallStatus,
  failed: (r: string): ToolCallStatus => ({ kind: "failed", data: { retriable: true, reason: r } }),
};
const tool = (name: string, status: ToolCallStatus, body: ToolCallBody, result: ToolCallResult | null = null): ToolCallSpec =>
  ({ id: nid("t"), name, render: { kind: "chatInline" }, status, body, result });
const generic = (args: Record<string, unknown>): ToolCallBody => ({ kind: "generic", data: { argsJson: JSON.stringify(args) } });
const gres = (o: unknown): ToolCallResult => ({ kind: "genericText", data: JSON.stringify(o) });
const tp = (spec: ToolCallSpec): MessagePart => ({ kind: "toolCall", data: spec });

const TINY_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#11161b"/><path d="M16 70 L60 30 L92 56 L120 28 L144 50" fill="none" stroke="#b59a63" stroke-width="2.5"/><circle cx="120" cy="28" r="4" fill="#d8382b"/></svg>',
)}`;

const researchDone: ResearchCardBody = {
  query: "杭州亚运会 开幕式 亮点", phase: "done", total: 5, fetchedCount: 5, okCount: 4, skippedCount: 1,
  items: [
    { url: "https://hangzhou2022.cn/a", title: "开幕式十大亮点", status: "done", wordCount: 1820 },
    { url: "https://news.cn/b", title: "数字火炬手背后的技术", status: "done", wordCount: 990 },
  ],
};
const svgDone: GenerateSvgCardBody = {
  prompt: "杭州亚运会主场馆示意", style: "line", aspect: "16:9",
  progress: { stage: "done", elapsedMs: 1500, rawKb: 4, message: "", error: null, src: TINY_SVG, width: 160, height: 90, partialSvg: null },
};
const draftDone: WriteDraftCardBody = {
  title: "杭州亚运会观察", phase: "done", charCount: 1180,
  excerpt: "本届亚运会的看点不止于金牌，更在于一座城市如何用科技与人文重新讲述自己。",
  targetLength: null, minLength: 800, maxLength: 1200, revisionCount: 0, lengthStatus: "accepted_first_pass",
};
const cmdDone: CommandCardBody = { title: "计算字数", icon: "🧮", command: "wc -m draft.md", exitCode: 0, outputTail: "1180", phase: "done" };
const qrData: QrCardBody = {
  content: "https://example.com/auth?code=DEMO", title: "扫码授权飞书", code: "WXYZ-1234",
  note: "请用飞书 App 扫码，或 [点此授权](https://example.com/auth)", expiresAt: 0, refreshQuery: "刷新", confirmQuery: "我已完成授权",
};
const askQ: AskUserQuestion[] = [
  { id: "q1", label: "文章篇幅", kind: { kind: "slider" }, options: [], placeholder: null, slider: { min: 300, max: 2000, step: 100, unit: "字", marks: null, aboveLabel: "2000 字以上" } },
  { id: "q2", label: "目标读者", kind: { kind: "single" }, options: [{ value: "public", label: "大众读者", description: null, preview: null }], placeholder: null },
  { id: "q3", label: "语气", kind: { kind: "text" }, options: [], placeholder: null },
];
const askA: Record<string, AskUserAnswer | undefined> = {
  q1: { chosen: [], freeText: null, numericValue: 800 },
  q2: { chosen: ["public"], freeText: null },
  q3: { chosen: [], freeText: "专业但不晦涩" },
};

// 轮级折叠的过程 parts(一段真实工作流)
const processParts: MessagePart[] = [
  { kind: "thinking", data: { id: nid("th"), steps: ["先读素材，再确认方向，然后写。"] } },
  tp(tool("parseFile", ST.done, generic({ filePath: "/uploads/赛事手册.pdf" }), gres({ wordCount: 8200 }))),
  tp(tool("readMaterial", ST.done, generic({ mode: "summary", materialId: "赛事手册" }))),
  tp(tool("askUser", ST.done, { kind: "askUser", data: { id: nid("a"), mode: { kind: "fullpage" }, purpose: null, source: null, rationale: null, questions: askQ } }, { kind: "askUserAnswers", data: askA })),
  tp(tool("webSearch", ST.done, { kind: "researchCard", data: researchDone })),
  tp(tool("writeDraft", ST.done, { kind: "writeDraftCard", data: draftDone })),
  tp(tool("generateSvg", ST.done, { kind: "generateSvg", data: svgDone })),
  { kind: "patchSummary", data: { count: 2, hunkIds: ["h"] } },
  tp(tool("mastra_workspace_write_file", ST.done, generic({ path: "/work/cover.svg" }), gres({ bytes: 2048 }))),
];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sp-row">
      <div className="sp-rowlbl">{label}</div>
      <div className="sp-rowbody u-scope">{children}</div>
    </div>
  );
}
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="sp-section">
      <h2 className="sp-h2">{title}{hint && <span className="sp-hint">{hint}</span>}</h2>
      {children}
    </section>
  );
}

export function SpecDemoPage() {
  return (
    <div id="view-workspace" className="sp-view" style={{ height: "100vh", overflow: "auto" }}>
      <div className="ws-left sp-scope">
        <div className="sp-wrap">
          <header className="sp-head">
            <h1 className="sp-h1">对话工具栏 · 最终设计 demo</h1>
            <p className="sp-sub">统一后的对话工具元素最终样式（直角 · 满宽 · 弱化成败 · 自设线性图标）。仅预览，未改生产。规范见飞书草案。</p>
          </header>

          <Section title="一、通用工具栏 · 五要素" hint="① 图标 ② 标题 ③ 参数 ④ 状态(右对齐) ⑤ 箭头；①②④ 必有，③⑤ 可选">
            <Row label="done（出参概要 + 详情折叠）"><UToolBar spec={tool("mastra_workspace_read_file", ST.done, generic({ path: "/work/draft.md" }), gres({ bytes: 4096 }))} /></Row>
            <Row label="running（三个点 + 入参）"><UToolBar spec={tool("parseFile", ST.running, generic({ filePath: "/uploads/赛事手册.pdf" }))} /></Row>
            <Row label="pending（等待 = 三个点）"><UToolBar spec={tool("editDraft", ST.pending, generic({ blockId: "b-12" }))} /></Row>
            <Row label="failed（同图标，仅「未完成」，不报红）"><UToolBar spec={tool("fetchArticle", ST.failed("超时"), generic({ url: "https://x.com" }))} /></Row>
            <Row label="只有标题（无参数 → 省 ③；无折叠 → 省 ⑤）"><UToolBar spec={tool("summarizeMaterial", ST.done, generic({}))} /></Row>
            <Row label="带 query 参数"><UToolBar spec={tool("skill_search", ST.done, generic({ query: "飞书多维表格" }), gres({ results: [1, 2, 3] }))} /></Row>
          </Section>

          <Section title="二、工具卡（统一外壳：图标+标题+副+状态+折叠）">
            <Row label="联网搜索 UResearch"><UResearch body={researchDone} /></Row>
            <Row label="生成配图 USvg"><USvg body={svgDone} status="done" /></Row>
            <Row label="生成草稿 UDraft"><UDraft body={draftDone} /></Row>
            <Row label="运行代码 UCommand"><UCommand body={cmdDone} /></Row>
            <Row label="确认方向 UAskUser"><UAskUser questions={askQ} answers={askA} /></Row>
            <Row label="扫码 UQr"><UQr data={qrData} /></Row>
          </Section>

          <Section title="三、其它元素">
            <Row label="二次编辑 UPatch"><UPatch count={2} /></Row>
            <Row label="来源卡 USource（带图）"><USource label="开幕式十大亮点 · 杭州亚运会官网" srcUrl="https://hangzhou2022.cn/a" thumb={TINY_SVG} /></Row>
            <Row label="来源卡 USource（无图）"><USource label="数字火炬手背后的技术" srcUrl="https://news.cn/b" thumb={null} /></Row>
            <Row label="引用 UCitation"><UCitation id="src-开幕式" anchor="2" /></Row>
          </Section>

          <Section title="四、轮级折叠（Codex 式）" hint="一轮结束：过程折成一条「过程 · N 步」，只留最终回复；点开看明细">
            <Row label="折叠态（默认）">
              <div className="sp-turn">
                <div className="u-userwrap"><div className="u-user">帮我写一篇杭州亚运会的观察报道，800 字左右。</div></div>
                <UTurnFold parts={processParts} />
                <div className="u-agent"><div style={{ marginBottom: 2 }}><strong>初稿已完成</strong>：约 800 字、面向大众、含一张示意配图，授权后即可发布。需要我调整语气吗？</div></div>
              </div>
            </Row>
            <Row label="展开态">
              <div className="sp-turn">
                <UTurnFold parts={processParts} defaultOpen />
              </div>
            </Row>
          </Section>
        </div>
      </div>
    </div>
  );
}
