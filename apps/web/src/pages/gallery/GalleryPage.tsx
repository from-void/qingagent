import { useMemo, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type {
  AskUserQuestion,
  ChatChip,
  ChatMessage,
  GenerateSvgProgressStage,
  MessagePart,
  ReviewOutcome,
  ToolCallBody,
  ToolCallResult,
  ToolCallSpec,
  ToolCallStatus,
} from "@qingagent/contract-ts";
import { ChatMessageList } from "../workspace/components/ChatMessageList";
import { DiagramRenderer } from "../workspace/components/diagram/DiagramRenderer";
import {
  shouldStickStreamErrorToast,
  streamErrorActionLabel,
  streamErrorToastMessage,
  streamErrorToastRole,
  streamErrorToastTone,
} from "../workspace/components/streamErrorPresenter";
import { IMPROVED_LABELS, UToolBar, URevampPart, UTurnFold } from "./revampUi";
import type { StreamError } from "../workspace/data/protocol";
import { useConfirm, useToast } from "../../system";
import "../workspace/workspace.css";
import "../workspace/workspace-ink-skin.css";
import "./gallery.css";

// ─────────────────────────────────────────────────────────────────────────
// 对话嵌入元素「多态画廊」(debug 页, #/gallery)
// 目标:把对话流里**所有非正文元素**(消息气泡 / 思考 / 工具状态行 / 各类工具卡 /
// 占位卡 / 引用块 / 错误条…)的**每一个状态**,用生产渲染路径/生产 presenter
// 渲染成一张大表,平铺对比、暴露样式不统一,作为统一
// 规范(chat-polish)的依据。不复刻样式、不手搓 HTML——全部走生产组件。
// ─────────────────────────────────────────────────────────────────────────

let _seq = 0;
const nid = (p: string) => `${p}-${++_seq}`;

// ── 消息 / part 构造 ─────────────────────────────────────────────────────
function agentMsg(parts: MessagePart[]): ChatMessage {
  return { id: nid("a"), role: { kind: "agent" }, ts: "", parts, chips: null };
}
function userMsg(body: string, chips: ChatChip[] | null = null): ChatMessage {
  return {
    id: nid("u"),
    role: { kind: "user" },
    ts: "",
    parts: [{ kind: "text", data: { body } }],
    chips,
  };
}
function toolMsg(spec: ToolCallSpec): ChatMessage {
  return agentMsg([{ kind: "toolCall", data: spec }]);
}

// ── ToolCallStatus 速记 ──────────────────────────────────────────────────
const ST = {
  pending: { kind: "pending" } as ToolCallStatus,
  running: { kind: "running", data: { progressPct: null, etaSec: null } } as ToolCallStatus,
  done: { kind: "done" } as ToolCallStatus,
  aborted: { kind: "aborted" } as ToolCallStatus,
  reviewing: { kind: "reviewing" } as ToolCallStatus,
  accepted: { kind: "accepted" } as ToolCallStatus,
  rejected: { kind: "rejected" } as ToolCallStatus,
  committed: { kind: "committed" } as ToolCallStatus,
  failed: (reason: string): ToolCallStatus => ({ kind: "failed", data: { retriable: true, reason } }),
};

function tool(name: string, status: ToolCallStatus, body: ToolCallBody, result: ToolCallResult | null = null): ToolCallSpec {
  return { id: nid("t"), name, render: { kind: "chatInline" }, status, body, result };
}
function genericBody(args: Record<string, unknown>): ToolCallBody {
  return { kind: "generic", data: { argsJson: JSON.stringify(args) } };
}
function genericResult(obj: unknown): ToolCallResult {
  return { kind: "genericText", data: JSON.stringify(obj) };
}

// ── 渲染单元格:真实 ChatMessageList 分发 ──────────────────────────────────
type ChatProps = React.ComponentProps<typeof ChatMessageList>;
function Cell(props: Partial<ChatProps> & { messages: ChatMessage[] }) {
  const { messages, streamActive = false, ...rest } = props;
  return (
    <div className="gx-sample">
      <ChatMessageList messages={messages} streamActive={streamActive} {...rest} />
    </div>
  );
}

function DiagramSample({ source }: { source: string }) {
  return (
    <div className="gx-diagram-sample">
      <DiagramRenderer source={source} readOnly />
    </div>
  );
}

// 工具的代表性 in/out 例子(现状 + 改进版都喂同一份,看差异)。
// result 形状刻意贴齐后端 toolResultCardSummary 的紧凑 JSON(顶层标量 + 数组长度 `<key>Count`
// + 下钻一层 `<父>.<子>` 标量),这样这里演示的完成态文案就是生产真实会出现的文案。
const TOOL_EXAMPLES: Record<string, { args: Record<string, unknown>; result?: unknown }> = {
  readMaterial: { args: { mode: "summary", materialId: "赛事手册" }, result: { filename: "赛事手册", wordCount: 1240 } },
  summarizeMaterial: { args: { materialId: "赛事手册.pdf" }, result: { updated: true } },
  readDraft: { args: {}, result: { ok: true, blockCount: 18, wordCount: 1180 } },
  // editDraft 真实输出:applied[]→appliedCount、changed(布尔)、hunkCount。
  editDraft: { args: { blockId: "b-12" }, result: { ok: true, appliedCount: 3, changed: true, hunkCount: 3 } },
  // readDiff 的 stats 嵌套被后端提升成 `stats.*`,前端据此报「N 处差异」。
  readDiff: { args: {}, result: { ok: true, changesCount: 5, "stats.blocksChanged": 4, "stats.marksChanged": 1, "stats.totalWords": 1180 } },
  // parseFile 字数在 metadata 里,后端提升成 `metadata.wordCount`。
  parseFile: { args: { filePath: "/uploads/赛事手册.pdf" }, result: { "metadata.wordCount": 8200, "metadata.pages": 12 } },
  storeMaterial: { args: { filename: "赛事手册.pdf" }, result: { materialId: "mat-1", stored: true } },
  skill: { args: { skill: "飞书多维表格" } },
  skill_read: { args: { skill: "飞书多维表格" } },
  skill_search: { args: { query: "飞书多维表格" }, result: { results: [1, 2, 3] } },
  browser_goto: { args: { url: "https://www.hangzhou2022.cn" } },
  browser_snapshot: { args: { url: "https://hangzhou2022.cn/news" } },
  browser_click: { args: { selector: "button.submit" } },
  browser_type: { args: { text: "杭州亚运会" } },
  browser_press: { args: { key: "Enter" } },
  browser_wait: { args: { selector: ".loaded" } },
  browser_scroll: { args: { direction: "down" } },
  browser_back: { args: {} },
  mastra_workspace_read_file: { args: { path: "/work/draft.md" }, result: { wordCount: 1180 } },
  mastra_workspace_write_file: { args: { path: "/work/out.md" }, result: { wordCount: 860 } },
  mastra_workspace_edit_file: { args: { path: "/work/draft.md" }, result: { changed: 2 } },
  mastra_workspace_list_files: { args: { path: "/work" }, result: { items: [1, 2, 3, 4, 5] } },
  mastra_workspace_delete: { args: { path: "/work/tmp.txt" } },
  mastra_workspace_file_stat: { args: { path: "/work/draft.md" }, result: { size: 4096 } },
  mastra_workspace_mkdir: { args: { path: "/work/sub" } },
  mastra_workspace_grep: { args: { pattern: "亚运", path: "/work" }, result: { matches: 12 } },
  mastra_workspace_get_process_output: { args: { pid: "1234" } },
  mastra_workspace_kill_process: { args: { pid: "1234" } },
  mastra_workspace_search: { args: { query: "亚运" }, result: { results: [1, 2, 3] } },
  readDocument: { args: { name: "赛事手册.pdf" }, result: { ok: true, wordCount: 2400, cacheHit: false } },
  searchDocuments: { args: { query: "亚运" }, result: { ok: true, query: "亚运", resultsCount: 4 } },
  spawnSubAgent: { args: { name: "配图子任务" } },
};

// 走通用灰行的工具清单(专用卡的工具不在此,它们已在 F-L 组).each: 现状 vs 改进 对比
const INLINE_TOOLS: { name: string; param: string; dead?: string }[] = [
  { name: "skill", param: "技能名（必填）" },
  { name: "skill_search", param: "query（必填）" },
  { name: "readMaterial", param: "mode（必填）" },
  { name: "parseFile", param: "仅标题", dead: "段读 a.filename 但入参 filePath→失效" },
  { name: "summarizeMaterial", param: "仅标题" },
  { name: "readDraft", param: "仅标题" },
  { name: "editDraft", param: "仅标题" },
  { name: "readDiff", param: "仅标题" },
  { name: "browser_snapshot", param: "仅标题" },
  { name: "browser_scroll", param: "仅标题" },
  { name: "mastra_workspace_read_file", param: "仅标题" },
  { name: "mastra_workspace_write_file", param: "仅标题" },
  { name: "mastra_workspace_edit_file", param: "仅标题" },
  { name: "mastra_workspace_list_files", param: "仅标题" },
  { name: "mastra_workspace_grep", param: "仅标题" },
  { name: "mastra_workspace_search", param: "query（必填）" },
  { name: "readDocument", param: "无·裸『工具调用』", dead: "未映射(后端在用)" },
  { name: "searchDocuments", param: "无·裸『工具调用』", dead: "未映射(后端在用)" },
];

function exampleSpec(name: string, status: ToolCallStatus): ToolCallSpec {
  const ex = TOOL_EXAMPLES[name] ?? { args: {} };
  const result = ex.result != null ? genericResult(ex.result) : null;
  return tool(name, status, genericBody(ex.args), status.kind === "done" ? result : null);
}

// 一个工具的「多态」堆叠:调用时(running)+ 调用后(done),各带状态名标签。
// mode=live 用现状 ToolCallRow;mode=improved 用统一 UToolBar(最终样式)。
function ToolStates({ name, mode }: { name: string; mode: "live" | "improved" }) {
  const states: { tag: string; status: ToolCallStatus }[] = [
    { tag: "调用时 · running", status: ST.running },
    { tag: "调用后 · done", status: ST.done },
  ];
  return (
    <div>
      {states.map((s) => (
        <div key={s.tag} style={{ marginBottom: 8 }}>
          <div className="gx-ministate">{s.tag}</div>
          {mode === "live" ? (
            <Cell messages={[toolMsg(exampleSpec(name, s.status))]} />
          ) : (
            <div className="gx-sample u-scope"><UToolBar spec={exampleSpec(name, s.status)} /></div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── 行 / 组 数据结构 ─────────────────────────────────────────────────────
interface Row {
  state: string;
  /** 状态码 / 判定字段(英文)。 */
  code?: string;
  /** 占位符 / 文案样例(中文原文)。 */
  copy: ReactNode;
  /** 样式来源 file:line / className。 */
  src: string;
  /** 现状渲染(真实生产组件)。 */
  render: ReactNode;
  /** 改进后 demo(真实拼);undefined = 暂无改进(留白)。 */
  improved?: ReactNode;
}
interface Group {
  title: string;
  meta: string;
  rows: Row[];
  /** 用户专门定制、不走统一标准化的组:改进列统一显示此说明,不渲染 U 组件。 */
  customNote?: string;
  /** 已废弃/死代码:改进列标红说明,不渲染。 */
  deprecated?: string;
}

// 小工具:tiny SVG data URI(给 generateSvg done / 图片卡用,离线可渲染)
const TINY_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#11161b"/><path d="M16 70 L60 30 L92 56 L120 28 L144 50" fill="none" stroke="#b59a63" stroke-width="2.5"/><circle cx="120" cy="28" r="4" fill="#d8382b"/></svg>',
)}`;
const PARTIAL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#11161b"/><path d="M16 70 L60 30 L92 56" fill="none" stroke="#b59a63" stroke-width="2.5"/></svg>';

function buildGroups(): Group[] {
  // 引用 chips(三种 kind)
  const chips: ChatChip[] = [
    { kind: { kind: "selection" }, resourceRef: { id: "sp1", domain: { kind: "docSpan" } }, prefix: null, label: "本届亚运会规模空前", suffix: "正文" },
    { kind: { kind: "attach" }, resourceRef: { id: "f1", domain: { kind: "file" } }, prefix: null, label: "赛事手册.pdf", suffix: null },
    { kind: { kind: "mention" }, resourceRef: { id: "m1", domain: { kind: "mention" } }, prefix: null, label: "开幕式", suffix: null },
  ];

  // askUser fullpage done 用的问题 + 答案
  const askQuestions: AskUserQuestion[] = [
    { id: "q1", label: "文章篇幅", kind: { kind: "slider" }, options: [], placeholder: null, slider: { min: 300, max: 2000, step: 100, unit: "字", marks: null, aboveLabel: "2000 字以上" } },
    { id: "q2", label: "目标读者", kind: { kind: "single" }, options: [
      { value: "pro", label: "专业人士", description: null, preview: null },
      { value: "public", label: "大众读者", description: null, preview: null },
    ], placeholder: null },
    { id: "q3", label: "语气风格", kind: { kind: "text" }, options: [], placeholder: "如:正式 / 活泼" },
  ];
  const askAnswers: ToolCallResult = {
    kind: "askUserAnswers",
    data: {
      q1: { chosen: [], freeText: null, numericValue: 1200 },
      q2: { chosen: ["public"], freeText: null },
      q3: { chosen: [], freeText: "专业但不晦涩" },
    },
  };

  const now = Date.now();

  const groups: Group[] = [
    // ── A. 消息容器 / 气泡 ──
    {
      title: "A · 消息气泡 / 容器",
      meta: "ChatMessageList.tsx:211 MessageRow",
      rows: [
        {
          state: "用户气泡",
          code: 'role.kind="user"',
          copy: "帮我写一篇关于杭州亚运会的观察报道，800 字左右。",
          src: "InkBubble · .wf-msg.user · skin:228",
          render: <Cell messages={[userMsg("帮我写一篇关于杭州亚运会的观察报道，800 字左右。")]} />,
        },
        {
          state: "用户气泡 · 带引用 chip",
          code: "chips[] + {{chip:N}}",
          copy: "三种 chip: selection(❝正文) / attach(📎文件) / mention(@提及)",
          src: ".chat-chip · workspace.css:497",
          render: <Cell messages={[userMsg("帮我把 {{chip:0}} 改正式些，参考 {{chip:1}} 和 {{chip:2}}。", chips)]} />,
        },
        {
          state: "AI 文本气泡 · markdown",
          code: 'role.kind="agent" · text',
          copy: "标题 / 粗体 / 列表 / 表格 / 行内代码 / 链接 / 引用 全套 markdown 渲染",
          src: ".wf-msg.agent · renderSimpleMarkdown:357",
          render: (
            <Cell
              messages={[
                agentMsg([
                  {
                    kind: "text",
                    data: {
                      body:
                        "## 报道结构建议\n\n我建议从**三条线**展开：\n\n- 赛事亮点\n- 城市运营\n- 人文故事\n\n| 维度 | 角度 |\n| --- | --- |\n| 竞技 | 金牌与突破 |\n| 城市 | 智慧亚运 |\n\n> 先确认方向再动笔。\n\n用 `editDraft` 落到正文。",
                    },
                  },
                ]),
              ]}
            />
          ),
        },
        {
          state: "空状态提示",
          code: "messages.length === 0",
          copy: "还没有对话 · 拿到素材后会先和你确认方向。",
          src: ".wf-msg.agent · ChatEmptyHint",
          render: <Cell messages={[]} />,
        },
        {
          state: "底部生成中",
          code: "showLoading",
          copy: "正在生成内容…",
          src: ".chat-loading-dots · ChatMessageList:113",
          render: <Cell messages={[]} showLoading />,
        },
      ],
    },

    // ── A2. Mermaid 节点-边图真实渲染 ──
    {
      title: "A2 · Mermaid 节点-边图（React Flow）",
      meta: "DiagramRenderer / GraphDiagramView · flowchart/state/er/class/mindmap",
      rows: [
        {
          state: "flowchart",
          code: "flowchart TD",
          copy: "稳定节点 id + 简单边；语义源仍是 Mermaid source。",
          src: "DiagramRenderer → GraphDiagramView",
          render: <DiagramSample source={`flowchart TD
  A[选题] -->|确认| B[写作]
  B --> C[交付]
`} />,
        },
        {
          state: "state",
          code: "stateDiagram-v2",
          copy: "state alias + transition；只开放可安全回写的子集。",
          src: "DiagramRenderer → GraphDiagramView",
          render: <DiagramSample source={`stateDiagram-v2
  state "待确认" as Pending
  Pending --> Writing : approve
  Writing --> Done : submit
`} />,
        },
        {
          state: "er",
          code: "erDiagram",
          copy: "实体关系可视化；实体改名保持只读。",
          src: "DiagramRenderer → GraphDiagramView",
          render: <DiagramSample source={`erDiagram
  USER ||--o{ DOCUMENT : owns
  DOCUMENT ||--o{ COMMENT : has
`} />,
        },
        {
          state: "class",
          code: "classDiagram",
          copy: "类关系可视化；类名改名保持只读。",
          src: "DiagramRenderer → GraphDiagramView",
          render: <DiagramSample source={`classDiagram
  DraftAgent <|-- ReviewAgent
  DraftAgent --> ToolRunner
`} />,
        },
        {
          state: "mindmap",
          code: "mindmap",
          copy: "缩进树派生稳定 id；同级重复 label 自动去重。",
          src: "DiagramRenderer → GraphDiagramView",
          render: <DiagramSample source={`mindmap
  写作任务
    资料
    大纲
    初稿
      审核
`} />,
        },
      ],
    },

    // ── B. 思考 ──
    {
      title: "B · 思考 (reasoning)",
      meta: "ThinkingMarquee.tsx / PartView thinking:718",
      rows: [
        {
          state: "思考中 · 滚动条",
          code: "streamActive && tail=thinking",
          copy: "思考中 + 解析出的首句滚动 (~1.2s/条)",
          src: ".ws-think-marquee · skin:1818",
          render: (
            <Cell
              streamActive
              messages={[
                agentMsg([{ kind: "thinking", data: { id: nid("th"), steps: ["用户想要一篇杭州亚运会报道。我得先确认篇幅、读者和语气，再决定结构。"] } }]),
              ]}
            />
          ),
        },
        {
          state: "思考 · 可展开 (debug)",
          code: "debugMode",
          copy: "已深度思考 (N 字) · 点击展开全文",
          src: ".wf-msg.tool caret · PartView:725",
          render: (
            <Cell
              debugMode
              messages={[
                agentMsg([{ kind: "thinking", data: { id: nid("th"), steps: ["用户想要一篇杭州亚运会报道。先确认方向：篇幅 800 字、面向大众、语气专业但不晦涩。"] } }]),
              ]}
            />
          ),
        },
      ],
    },

    // ── C. 通用工具状态行 (统一灰行) · 4 状态 现状 vs 改进 ──
    {
      title: "C · 通用工具状态行 (wf-tool-row) · 4 状态",
      meta: "ToolCallRow:985 · 例:读取文件(Mastra内置)",
      rows: (["pending", "running", "done", "failed"] as const).map((k) => {
        const status = k === "failed" ? ST.failed("沙箱无此文件") : ST[k];
        const copyMap: Record<string, string> = {
          pending: "· 读取文件 (灰点)",
          running: "⠿ 读取文件 (三点 loading)",
          done: "读取文件（完成）—— 现状不显示是哪个文件",
          failed: "读取文件 —— ⚠失败=done 同形,前端不暴露失败",
        };
        return {
          state: k,
          code: `status.kind="${k}"`,
          copy: copyMap[k],
          src: k === "failed" ? "showDone=isDone||failed:1128" : ".wf-tool-row:3572",
          render: <Cell messages={[toolMsg(exampleSpec("mastra_workspace_read_file", status))]} />,
          improved: <div className="gx-sample u-scope"><UToolBar spec={exampleSpec("mastra_workspace_read_file", status)} /></div>,
        };
      }),
    },

    // ── E. 二次编辑审批 patchSummary ──
    {
      title: "E · 二次编辑审批 patchSummary",
      meta: "PartView patchSummary:773",
      rows: [
        {
          state: "历史 · 已修改 N 处",
          code: "无 live 信号",
          copy: "已修改 5 处",
          src: ".wf-msg.tool",
          render: <Cell messages={[agentMsg([{ kind: "patchSummary", data: { count: 5, hunkIds: ["hh"] } }])]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "patchSummary", data: { count: 5, hunkIds: ["hh"] } }} /></div></div>,
        },
        {
          state: "当前轮 · 待确认",
          code: "isLive (livePatchCount+liveHunkKey)",
          copy: "已修改 3 处 · 待确认",
          src: "ChatMessageList:788",
          render: <Cell messages={[agentMsg([{ kind: "patchSummary", data: { count: 3, hunkIds: ["h1"] } }])]} livePatchCount={3} liveHunkKey="h1" sessionId="s1" />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "patchSummary", data: { count: 3, hunkIds: ["h1"] } }} /></div></div>,
        },
        {
          state: "正在应用修改",
          code: "patchRevealing",
          copy: "正在应用修改…",
          src: ".chat-loading-dots",
          render: <Cell messages={[agentMsg([{ kind: "patchSummary", data: { count: 3, hunkIds: ["h1"] } }])]} livePatchCount={3} liveHunkKey="h1" sessionId="s1" patchRevealing />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "patchSummary", data: { count: 3, hunkIds: ["h1"] } }} /></div></div>,
        },
        {
          state: "整篇改写 (大改 ≥70%)",
          code: "wholeDocReview",
          copy: "整篇改写 · 待确认",
          src: "ChatMessageList:803",
          render: <Cell messages={[agentMsg([{ kind: "patchSummary", data: { count: 12, hunkIds: ["h1"] } }])]} livePatchCount={12} liveHunkKey="h1" sessionId="s1" wholeDocReview />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "patchSummary", data: { count: 12, hunkIds: ["h1"] } }} /></div></div>,
        },
        {
          state: "候选已放弃",
          code: 'reviewOutcome="abandoned"',
          copy: "本轮候选已放弃，正文保持上一版",
          src: "ChatMessageList:797",
          render: <Cell messages={[agentMsg([abandonedPatch()])]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={abandonedPatch()} /></div></div>,
        },
      ],
    },

    // ── F. 生成草稿 DraftMiniCard ──
    {
      title: "F · 生成草稿 DraftMiniCard",
      meta: "DraftMiniCard.tsx · .ws-draft-card",
      customNote: "草稿专门定制一组样式",
      rows: [
        {
          state: "writing · 酝酿中",
          code: 'phase="writing" 无 excerpt',
          copy: "酝酿中 (草稿标签 + 标题 + loading)",
          src: ".ws-draft-brewing · skin:1668",
          render: <Cell messages={[toolMsg(tool("writeDraft", ST.running, draftBody("writing", { charCount: 0, excerpt: null, minLength: 800, maxLength: 1200 })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("writeDraft", ST.running, draftBody("writing", { charCount: 0, excerpt: null, minLength: 800, maxLength: 1200 })) }} /></div></div>,
        },
        {
          state: "writing · 流式打字",
          code: 'phase="writing" +excerpt',
          copy: "正在写作 · 目标 800–1200 字 (打字机 + 光标▍)",
          src: ".ws-draft-body · caret",
          render: <Cell messages={[toolMsg(tool("writeDraft", ST.running, draftBody("writing", { charCount: 320, excerpt: "本届亚运会的看点不止于金牌，更在于一座城市如何用科技与人文重新讲述自己。", minLength: 800, maxLength: 1200 })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("writeDraft", ST.running, draftBody("writing", { charCount: 320, excerpt: "本届亚运会的看点不止于金牌，更在于一座城市如何用科技与人文重新讲述自己。", minLength: 800, maxLength: 1200 })) }} /></div></div>,
        },
        {
          state: "revising · 字数修订",
          code: 'phase="revising"',
          copy: "字数修订中(第 2 轮) · 已写 760 字",
          src: "progressLine:20",
          render: <Cell messages={[toolMsg(tool("writeDraft", ST.running, draftBody("revising", { charCount: 760, excerpt: "……继续补足细节，让论述更扎实。", revisionCount: 2, minLength: 800, maxLength: 1200 })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("writeDraft", ST.running, draftBody("revising", { charCount: 760, excerpt: "……继续补足细节，让论述更扎实。", revisionCount: 2, minLength: 800, maxLength: 1200 })) }} /></div></div>,
        },
        {
          state: "done · 字数达标",
          code: 'phase="done"',
          copy: "1180 字 · 字数达标",
          src: "lengthStatusLabel:8",
          render: <Cell messages={[toolMsg(tool("writeDraft", ST.done, draftBody("done", { charCount: 1180, excerpt: "本届亚运会的看点不止于金牌……(全文)", lengthStatus: "accepted_first_pass", minLength: 800, maxLength: 1200 })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("writeDraft", ST.done, draftBody("done", { charCount: 1180, excerpt: "本届亚运会的看点不止于金牌……(全文)", lengthStatus: "accepted_first_pass", minLength: 800, maxLength: 1200 })) }} /></div></div>,
        },
        {
          state: "failed",
          code: 'phase="failed"',
          copy: "生成失败,可重试",
          src: ".ws-draft-fail",
          render: <Cell messages={[toolMsg(tool("writeDraft", ST.failed("生成失败"), draftBody("failed", { charCount: 0, excerpt: null })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("writeDraft", ST.failed("生成失败"), draftBody("failed", { charCount: 0, excerpt: null })) }} /></div></div>,
        },
      ],
    },

    // ── G. 识别图片 ReadImageRow ──
    {
      title: "G · 识别图片 ReadImageRow",
      meta: "ReadImageRow:830",
      rows: [
        {
          state: "running · 流式摘录",
          code: 'status="running"',
          copy: "识别图片 · (副基模流式文字滚动)",
          src: ".wf-tool-row · useThinkingMarquee",
          render: <Cell messages={[toolMsg(tool("readImage", ST.running, { kind: "readImageCard", data: { prompt: "识别这张图", thumbnailSrc: null, excerpt: "图中是一座体育馆，屋顶为波浪形钢结构，夜间亮起暖色灯光……" } }))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("readImage", ST.running, { kind: "readImageCard", data: { prompt: "识别这张体育馆夜景图，描述屋顶结构、灯光与整体氛围，尽量具体", thumbnailSrc: TINY_SVG, excerpt: "图中是一座体育馆，屋顶为波浪形钢结构，夜间亮起暖色灯光……" } }) }} /></div></div>,
        },
        {
          state: "done",
          code: 'status="done"',
          copy: "识别图片（完成）",
          src: "CheckIcon size=12",
          render: <Cell messages={[toolMsg(tool("readImage", ST.done, { kind: "readImageCard", data: { prompt: "识别这张图", thumbnailSrc: null, excerpt: "一座波浪形屋顶的体育馆。" } }))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("readImage", ST.done, { kind: "readImageCard", data: { prompt: "识别这张图", thumbnailSrc: null, excerpt: "一座波浪形屋顶的体育馆。" } }) }} /></div></div>,
        },
      ],
    },

    // ── H. 确认方向 askUser (fullpage) ──
    {
      title: "H · 确认方向 askUser",
      meta: "ToolCallRow askUser:1053 / .askuser-card",
      customNote: "保持原样式 · 仅把宽度拉满",
      rows: [
        {
          state: "pending · 等待确认",
          code: 'status="pending"',
          copy: "● 等待您的确认 (脉冲点 au-pulse)",
          src: "var(--mark) au-pulse:1117",
          render: <Cell messages={[toolMsg(tool("askUser", ST.pending, askUserBody([])))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("askUser", ST.pending, askUserBody([])) }} /></div></div>,
        },
        {
          state: "running · 准备问题",
          code: 'status="running"',
          copy: "⠿ 正在准备问题",
          src: ".chat-loading-dots",
          render: <Cell messages={[toolMsg(tool("askUser", ST.running, askUserBody([])))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("askUser", ST.running, askUserBody([])) }} /></div></div>,
        },
        {
          state: "done · 答案汇总卡",
          code: 'status="done" +askUserAnswers',
          copy: "已提交答案 + 各问题答案行",
          src: ".askuser-card · skin:1706",
          render: <Cell messages={[toolMsg(tool("askUser", ST.done, askUserBody(askQuestions), askAnswers))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("askUser", ST.done, askUserBody(askQuestions), askAnswers) }} /></div></div>,
        },
      ],
    },

    // ── I. 生成配图 GenerateSvgRow ──
    {
      title: "I · 生成配图 GenerateSvgRow",
      meta: "GenerateSvgRow:861 / .svg-card",
      rows: [
        {
          state: "starting",
          code: 'progress.stage="starting"',
          copy: "生成配图 · 正在输出 SVG (转圈)",
          src: ".svg-card · workspace.css:3338",
          render: <Cell messages={[toolMsg(tool("generateSvg", ST.running, svgBody("starting", { prompt: "杭州亚运会主场馆示意" })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("generateSvg", ST.running, svgBody("starting", { prompt: "杭州亚运会主场馆示意" })) }} /></div></div>,
        },
        {
          state: "streaming · 草稿",
          code: 'progress.stage="streaming" +partialSvg',
          copy: "正在输出 SVG + 半截草稿预览",
          src: ".svg-thumb-draft",
          render: <Cell messages={[toolMsg(tool("generateSvg", ST.running, svgBody("streaming", { prompt: "杭州亚运会主场馆示意", partialSvg: PARTIAL_SVG })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("generateSvg", ST.running, svgBody("streaming", { prompt: "杭州亚运会主场馆示意", partialSvg: PARTIAL_SVG })) }} /></div></div>,
        },
        {
          state: "done (默认折叠)",
          code: 'status="done" +src',
          copy: "生成配图 · 已生成 ▾ (折叠头，点开看图)",
          src: ".svg-head-btn",
          render: <Cell messages={[toolMsg(tool("generateSvg", ST.done, svgBody("done", { prompt: "杭州亚运会主场馆示意", src: TINY_SVG, width: 160, height: 90 })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("generateSvg", ST.done, svgBody("done", { prompt: "杭州亚运会主场馆示意", src: TINY_SVG, width: 160, height: 90 })) }} /></div></div>,
        },
        {
          state: "failed",
          code: 'progress.stage="failed"',
          copy: "! 生成配图 · 生成失败 + 原因",
          src: ".svg-error",
          render: <Cell messages={[toolMsg(tool("generateSvg", ST.failed("SVG 不合法"), svgBody("failed", { prompt: "杭州亚运会主场馆示意", error: "SVG 结构不完整，已放弃" })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("generateSvg", ST.failed("SVG 不合法"), svgBody("failed", { prompt: "杭州亚运会主场馆示意", error: "SVG 结构不完整，已放弃" })) }} /></div></div>,
        },
      ],
    },

    // ── J. 联网搜索 ResearchCard ──
    {
      title: "J · 联网搜索 ResearchCard",
      meta: "ResearchCard.tsx / .rs-card",
      rows: [
        {
          state: "searching",
          code: 'phase="searching"',
          copy: "检索『…』· 检索中… (转圈)",
          src: ".rs-card · workspace.css:3153",
          render: <Cell messages={[toolMsg(tool("webSearch", ST.running, researchBody("searching", {})))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("webSearch", ST.running, researchBody("searching", {})) }} /></div></div>,
        },
        {
          state: "fetching · 逐行抓取",
          code: 'phase="fetching"',
          copy: "抓取 2/5 + 列表(待抓取/抓取中/经浏览器/已抓取 多态行)",
          src: ".rs-list .rs-row · 3208",
          render: (
            <Cell
              messages={[
                toolMsg(
                  tool("webSearch", ST.running, researchBody("fetching", {
                    total: 5,
                    fetchedCount: 2,
                    okCount: 2,
                    items: [
                      { url: "https://hangzhou2022.cn/a", title: "开幕式十大亮点", status: "done", wordCount: 1820 },
                      { url: "https://news.cn/b", title: "数字火炬手背后的技术", status: "browser", wordCount: null },
                      { url: "https://xinhua.com/c", title: "赛事运营全记录", status: "fetching", wordCount: null },
                      { url: "https://example.com/d", title: "门票与交通指南", status: "pending", wordCount: null },
                    ],
                  })),
                ),
              ]}
            />
          ),
          improved: (
            <div className="gx-sample u-scope"><div className="wf-msg agent">
              <URevampPart part={{ kind: "toolCall", data: tool("webSearch", ST.running, researchBody("fetching", {
                total: 5, fetchedCount: 2, okCount: 2,
                items: [
                  { url: "https://hangzhou2022.cn/a", title: "开幕式十大亮点", status: "done", wordCount: 1820 },
                  { url: "https://news.cn/b", title: "数字火炬手背后的技术", status: "browser", wordCount: null },
                  { url: "https://xinhua.com/c", title: "赛事运营全记录", status: "fetching", wordCount: null },
                  { url: "https://example.com/d", title: "门票与交通指南", status: "pending", wordCount: null },
                ],
              })) }} />
            </div></div>
          ),
        },
        {
          state: "done (默认折叠)",
          code: 'phase="done"',
          copy: "检索『…』· 4 篇 ▾ (折叠汇总)",
          src: ".rs-head-btn",
          render: <Cell messages={[toolMsg(tool("webSearch", ST.done, researchBody("done", { total: 5, fetchedCount: 5, okCount: 4, skippedCount: 1, items: [{ url: "https://hangzhou2022.cn/a", title: "开幕式十大亮点", status: "done", wordCount: 1820 }] })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("webSearch", ST.done, researchBody("done", { total: 5, fetchedCount: 5, okCount: 4, skippedCount: 1, items: [{ url: "https://hangzhou2022.cn/a", title: "开幕式十大亮点", status: "done", wordCount: 1820 }] })) }} /></div></div>,
        },
      ],
    },

    // ── K. 命令执行 CommandCard ──
    {
      title: "K · 命令执行 CommandCard",
      meta: "CommandCard.tsx (内联 style, borderRadius:0)",
      rows: [
        {
          state: "running",
          code: 'phase="running"',
          copy: "🧮 计算字数 (图标 emoji + 三点 loading)",
          src: "inline style:14",
          render: <Cell messages={[toolMsg(tool("mastra_workspace_execute_command", ST.running, cmdBody("running", { title: "计算字数", icon: "🧮" })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("mastra_workspace_execute_command", ST.running, cmdBody("running", { title: "计算字数", icon: "🧮" })) }} /></div></div>,
        },
        {
          state: "done (可展开命令/输出)",
          code: 'phase="done" exitCode=0',
          copy: "🧮 计算字数 · 完成(金色) ▸",
          src: "金色不分红绿:52",
          render: <Cell messages={[toolMsg(tool("mastra_workspace_execute_command", ST.done, cmdBody("done", { title: "计算字数", icon: "🧮", outputTail: "1180" })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("mastra_workspace_execute_command", ST.done, cmdBody("done", { title: "计算字数", icon: "🧮", outputTail: "1180" })) }} /></div></div>,
        },
        {
          state: "failed",
          code: 'phase="failed" exitCode≠0',
          copy: "📤 发布到飞书 · 失败(金色) ▸",
          src: "退出码展示:100",
          render: <Cell messages={[toolMsg(tool("mastra_workspace_execute_command", ST.failed("非零退出"), cmdBody("failed", { title: "发布到飞书", icon: "📤", command: "lark doc create", exitCode: 1, outputTail: "permission denied" })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("mastra_workspace_execute_command", ST.failed("非零退出"), cmdBody("failed", { title: "发布到飞书", icon: "📤", command: "lark doc create", exitCode: 1, outputTail: "permission denied" })) }} /></div></div>,
        },
      ],
    },

    // ── L. 二维码 QrCard ──
    {
      title: "L · 二维码 QrCard",
      meta: "QrCard.tsx / QrCard.css · .qr-card",
      customNote: "做成卡片 · 不套工具样式",
      rows: [
        {
          state: "active",
          code: "now < expiresAt",
          copy: "标题 + 二维码 + note(轻量 markdown) + 倒计时",
          src: ".qr-card · QrCard.css",
          render: <Cell messages={[toolMsg(tool("show_qr", ST.done, qrBody({ expiresAt: now + 120000 })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("show_qr", ST.done, qrBody({ expiresAt: now + 120000 })) }} /></div></div>,
        },
        {
          state: "expired",
          code: "now ≥ expiresAt",
          copy: "二维码已失效，可点此重新获取（置灰打码）",
          src: ".qr-card__frame.is-expired",
          render: <Cell messages={[toolMsg(tool("show_qr", ST.done, qrBody({ expiresAt: now - 1000 })))]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "toolCall", data: tool("show_qr", ST.done, qrBody({ expiresAt: now - 1000 })) }} /></div></div>,
        },
      ],
    },

    // ── M. 链接 / 来源卡 ──
    {
      title: "M · 链接 / 来源卡",
      meta: "ChatLinkCard:584 / BrowserViewPart.tsx",
      customNote: "结果产出 · 非工具状态",
      rows: [
        {
          state: "链接卡 (整行链接)",
          code: "agent text = bare URL",
          copy: "链接 标题 + 域名 ↗",
          src: ".ws-link-card · skin:1741",
          render: <Cell messages={[agentMsg([{ kind: "text", data: { body: "https://www.hangzhou2022.cn/news/highlights" } }])]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "text", data: { body: "https://www.hangzhou2022.cn/news/highlights" } }} /></div></div>,
        },
        {
          state: "来源卡 · 带预览图",
          code: "image part, src≠null",
          copy: "缩略图 + 链接标题 + 域名 ↗",
          src: ".ws-link-card-img",
          render: <Cell messages={[agentMsg([{ kind: "image", data: { label: "杭州亚运会官网", src: TINY_SVG, srcKind: "url", sourceUrl: "https://hangzhou2022.cn", width: 160, height: 90 } }])]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "image", data: { label: "杭州亚运会官网", src: TINY_SVG, srcKind: "url", sourceUrl: "https://hangzhou2022.cn", width: 160, height: 90 } }} /></div></div>,
        },
        {
          state: "来源卡 · 无图(文字)",
          code: "image part, src=null",
          copy: "链接 标题 + 域名 ↗ (无缩略图)",
          src: "BrowserViewPart:38",
          render: <Cell messages={[agentMsg([{ kind: "image", data: { label: "亚运会赛程公布", src: null, srcKind: "url", sourceUrl: "https://example.com/schedule", width: null, height: null } }])]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "image", data: { label: "亚运会赛程公布", src: null, srcKind: "url", sourceUrl: "https://example.com/schedule", width: null, height: null } }} /></div></div>,
        },
      ],
    },

    // ── N. 引用标记 citation ──
    {
      title: "N · 引用标记 citation",
      meta: "PartView citation:765",
      customNote: "用户专门处理（含义待明确）",
      rows: [
        {
          state: "citation chip",
          code: 'kind="citation"',
          copy: "¶ src-12#3 (mono 小药丸)",
          src: ".wf-chip.mono",
          render: <Cell messages={[agentMsg([{ kind: "citation", data: { sourceRef: { id: "src-12", domain: { kind: "source" } }, anchor: "3" } }])]} />,
          improved: <div className="gx-sample u-scope"><div className="wf-msg agent"><URevampPart part={{ kind: "citation", data: { sourceRef: { id: "src-12", domain: { kind: "source" } }, anchor: "3" } }} /></div></div>,
        },
      ],
    },

    // ── O. 流级错误 toast ──
    {
      title: "O · 流级错误 toast",
      meta: "WorkspacePage → ToastProvider (.qa-toast)",
      rows: [
        {
          state: "failed · 连接失败 (可重试)",
          code: 'kind="failed" retriable',
          copy: "连接失败 · 网络连接中断,请重试 [重试] [✕]",
          src: "streamErrorPresenter → sticky error",
          render: <StreamErrorToastCell error={{ kind: "failed", reason: "网络连接中断，请重试", retriable: true }} />,
        },
        {
          state: "draftingFailed · 没有生成内容",
          code: 'kind="draftingFailed"',
          copy: "没有生成内容 · 模型返回空响应",
          src: "streamErrorToastMessage",
          render: <StreamErrorToastCell error={{ kind: "draftingFailed", reason: "模型返回空响应 (empty)" }} />,
        },
        {
          state: "cancelled (warn/status)",
          code: 'kind="cancelled"',
          copy: "已取消 · 已手动停止生成",
          src: "cancelled → transient warn",
          render: <StreamErrorToastCell error={{ kind: "cancelled", reason: "已手动停止生成" }} />,
        },
        {
          state: "quota · 余额不足 (不可重试)",
          code: "category=quota / 402",
          copy: "余额/配额不足 · [检查模型设置/余额] [✕]",
          src: "streamErrorActionLabel",
          render: <StreamErrorToastCell error={{ kind: "failed", reason: "账户余额不足", category: "quota", statusCode: 402, action: "check_balance", retriable: false }} />,
        },
      ],
    },

    // ── P. 全量内联工具 · 现状 vs 改进 demo(每个工具一行,左现状右改进) ──
    {
      title: "P · 全量内联工具 · 现状渲染 vs 改进 demo",
      meta: "走通用灰行的工具(专用卡工具见 F-L);改进=暴露主参数+输出概要+失败态+▸详情",
      rows: INLINE_TOOLS.map((t) => ({
        state: IMPROVED_LABELS[t.name] ?? t.name,
        code: t.name,
        copy: (
          <>
            <span className={t.param.startsWith("仅标题") || t.param.startsWith("无") ? "gx-copy-empty" : undefined}>{t.param}</span>
            {t.dead && <div style={{ color: "#e0866a", marginTop: 3, fontSize: 11 }}>⚠ {t.dead}</div>}
          </>
        ),
        src: t.dead ? `⚠ ${t.dead}` : "wf-tool-row",
        render: <ToolStates name={t.name} mode="live" />,
        improved: <ToolStates name={t.name} mode="improved" />,
      })),
    },

    // ── Q. 审核结果缩略卡 reviewOutcome(局部采纳/全部拒绝后以用户名义回流) ──
    {
      title: "Q · 审核反馈卡 reviewOutcome",
      meta: "PartView reviewOutcome → ReviewOutcomeCard.tsx;缩略=计数+拒绝项简述,点击展开看 before/after",
      customNote: "用户消息内嵌卡片,默认折叠展示被拒项简述,无独立改进版",
      rows: [
        {
          state: "局部采纳(采3拒2)",
          code: "acceptedCount=3 rejectedCount=2",
          copy: "采纳 3 处 · 拒绝 2 处",
          src: ".u-card · ReviewOutcomeCard.tsx",
          render: <Cell messages={[userMsg("")]} />,
        },
        {
          state: "全部拒绝(放弃本轮)",
          code: "acceptedCount=0 rejectedCount=3",
          copy: "放弃本轮全部 3 处修改",
          src: ".u-card · ReviewOutcomeCard.tsx",
          render: <Cell messages={[userMsg("")]} />,
        },
        {
          state: "单处拒绝",
          code: "rejectedCount=1",
          copy: "采纳 0 处 · 拒绝 1 处",
          src: ".u-card · ReviewOutcomeCard.tsx",
          render: <Cell messages={[userMsg("")]} />,
        },
      ].map((row, i) => ({
        ...row,
        render: <Cell messages={[reviewOutcomeMsg(REVIEW_OUTCOME_DEMOS[i]!)]} />,
      })),
    },
  ];
  return groups;
}

const REVIEW_OUTCOME_DEMOS: ReviewOutcome[] = [
  {
    acceptedCount: 3,
    rejectedCount: 2,
    hunks: [
      { verdict: "accepted", blockSummary: "开篇导语更凝练", beforeText: "杭州亚运会盛大开幕。", afterText: "钱塘江畔，亚运圣火点亮夜空。" },
      { verdict: "accepted", blockSummary: "第二段补数据", beforeText: "参赛人数众多。", afterText: "来自 45 个国家和地区的逾万名运动员同场竞技。" },
      { verdict: "accepted", blockSummary: "结尾升华", beforeText: "比赛很精彩。", afterText: "这场盛会，写下亚洲体育的崭新一页。" },
      { verdict: "rejected", blockSummary: "把'观察报道'改成'抒情散文'", beforeText: "本文以观察视角记录赛事。", afterText: "让我们一同沉醉在这诗意的夜晚……" },
      { verdict: "rejected", blockSummary: "插入大段背景介绍", beforeText: "", afterText: "亚运会起源于 1951 年，历经数十届……（长段落）" },
    ],
  },
  {
    acceptedCount: 0,
    rejectedCount: 3,
    hunks: [
      { verdict: "rejected", blockSummary: "整体改成第一人称", beforeText: "记者在现场看到。", afterText: "我站在看台上，心潮澎湃。" },
      { verdict: "rejected", blockSummary: "标题口语化", beforeText: "杭州亚运会开幕观察", afterText: "亚运会开幕啦！太震撼了" },
      { verdict: "rejected", blockSummary: "删掉数据段", beforeText: "逾万名运动员参赛。", afterText: "" },
    ],
  },
  {
    acceptedCount: 0,
    rejectedCount: 1,
    hunks: [
      { verdict: "rejected", blockSummary: "把'凝练'改回啰嗦表达", beforeText: "钱塘江畔，亚运圣火点亮夜空。", afterText: "在杭州这座美丽的城市的钱塘江的旁边，亚运会的圣火被点亮了，照亮了整个夜空。" },
    ],
  },
];

function reviewOutcomeMsg(outcome: ReviewOutcome): ChatMessage {
  return {
    id: nid("rvo"),
    role: { kind: "user" },
    ts: "",
    parts: [{ kind: "reviewOutcome", data: outcome }],
    chips: null,
  };
}

// ── 各卡片 body 构造器 ───────────────────────────────────────────────────
function abandonedPatch(): MessagePart {
  // reviewOutcome 是前端 getPatchSummaryReviewOutcome 读的扩展字段(协议未列),mock 时附加
  return { kind: "patchSummary", data: { count: 0, hunkIds: ["hx"], reviewOutcome: "abandoned" } } as unknown as MessagePart;
}

function askUserBody(questions: AskUserQuestion[]): ToolCallBody {
  return {
    kind: "askUser",
    data: { id: nid("ask"), mode: { kind: "fullpage" }, purpose: null, source: "确认方向", rationale: null, questions },
  };
}

function svgBody(
  stage: GenerateSvgProgressStage,
  opts: { prompt: string; src?: string; partialSvg?: string; error?: string; width?: number; height?: number },
): ToolCallBody {
  return {
    kind: "generateSvg",
    data: {
      prompt: opts.prompt,
      style: "line",
      aspect: "16:9",
      progress: {
        stage,
        elapsedMs: 1500,
        rawKb: 4,
        message: "",
        error: opts.error ?? null,
        src: opts.src ?? null,
        width: opts.width ?? null,
        height: opts.height ?? null,
        partialSvg: opts.partialSvg ?? null,
      },
    },
  };
}

function researchBody(
  phase: "searching" | "fetching" | "done",
  opts: { items?: ResearchItem[]; total?: number; fetchedCount?: number; okCount?: number; skippedCount?: number },
): ToolCallBody {
  return {
    kind: "researchCard",
    data: {
      query: "杭州亚运会 开幕式 亮点",
      phase,
      items: opts.items ?? [],
      total: opts.total ?? null,
      fetchedCount: opts.fetchedCount ?? 0,
      okCount: opts.okCount ?? 0,
      skippedCount: opts.skippedCount ?? 0,
    },
  };
}
type ResearchItem = ResearchCardBodyItems;
type ResearchCardBodyItems = Extract<ToolCallBody, { kind: "researchCard" }>["data"]["items"][number];

function draftBody(
  phase: "writing" | "revising" | "done" | "failed",
  opts: { charCount: number; excerpt: string | null; minLength?: number; maxLength?: number; revisionCount?: number; lengthStatus?: string },
): ToolCallBody {
  return {
    kind: "writeDraftCard",
    data: {
      title: "杭州亚运会观察",
      phase,
      charCount: opts.charCount,
      excerpt: opts.excerpt,
      targetLength: null,
      minLength: opts.minLength ?? null,
      maxLength: opts.maxLength ?? null,
      revisionCount: opts.revisionCount ?? 0,
      lengthStatus: opts.lengthStatus ?? null,
    },
  };
}

function cmdBody(
  phase: "running" | "done" | "failed",
  opts: { title: string; icon: string; command?: string; exitCode?: number; outputTail?: string },
): ToolCallBody {
  return {
    kind: "commandCard",
    data: {
      title: opts.title,
      icon: opts.icon,
      command: opts.command ?? "wc -m draft.md",
      exitCode: opts.exitCode ?? 0,
      outputTail: opts.outputTail ?? "",
      phase,
    },
  };
}

function qrBody(opts: { expiresAt: number }): ToolCallBody {
  return {
    kind: "qrCard",
    data: {
      content: "https://example.com/auth?code=DEMO-1234",
      title: "扫码授权飞书",
      code: "WXYZ-1234",
      note: "请用飞书 App 扫码，或 [点此授权](https://example.com/auth)",
      expiresAt: opts.expiresAt,
      refreshQuery: "刷新二维码",
      confirmQuery: "我已完成授权",
    },
  };
}

function StreamErrorToastCell({ error }: { error: StreamError }) {
  const tone = streamErrorToastTone(error);
  const sticky = shouldStickStreamErrorToast(error);
  const actionLabel = streamErrorActionLabel(error);
  const className = `qa-toast${tone === "info" ? "" : ` ${tone}`}${sticky ? " sticky" : ""}`;
  return (
    <div className="gx-sample">
      <div className={className} role={streamErrorToastRole(error)}>
        <span className="qa-toast-msg">{streamErrorToastMessage(error)}</span>
        {actionLabel ? (
          <button className="qa-toast-act" type="button">{actionLabel}</button>
        ) : null}
        {sticky ? (
          <button className="qa-toast-x" type="button" aria-label="关闭">×</button>
        ) : null}
      </div>
    </div>
  );
}

// ═══════════ 全量工具 · 在用审计(基于运行时 /api/v1/debug/tools + 后端 emit/引用核实) ═══════════
// 核心 = 运行时确认注册(debug 端点 14 个);门控 = 代码确认注册但能力/会话/资料库门控启用;
// 废弃 = 后端 0 emit / 0 引用,前端有分支/标签但永不触发。
type Usage = "核心" | "门控" | "废弃";
// param = pickMainParam 取的主参数位(参数优先级 PARAM_PRIORITY);
// output = pickOutputSummary 设计的完成态右侧状态文案(已对齐 toolResultCardSummary 紧凑字段:
//   顶层标量 / 数组长度 `<key>Count` / 下钻一层 `<父>.<子>` 标量)。"已完成"= 无定制、走默认兜底。
interface ToolAudit { name: string; label: string; render: string; usage: Usage; param: string; output: string; note: string; }
const TOOL_AUDIT: ToolAudit[] = [
  // —— 核心:运行时 debug 端点确认(14) ——
  { name: "askUser", label: "确认方向", render: "askUser 行/卡", usage: "核心", param: "—", output: "(走问答卡,非灰行)", note: "agent 固定工具" },
  { name: "parseFile", label: "解析文件", render: "通用灰行", usage: "核心", param: "filePath→文件名", output: "N 字(metadata.wordCount,后端已提升嵌套)", note: "agent 固定工具" },
  { name: "storeMaterial", label: "存储素材", render: "通用灰行", usage: "核心", param: "—", output: "已存素材 / 未存储(stored)", note: "agent 固定工具" },
  { name: "fetchArticle", label: "网页抓取", render: "通用行+来源卡", usage: "核心", param: "url→host", output: "N 字(wordCount)", note: "agent 固定工具" },
  { name: "webSearch", label: "联网搜索", render: "ResearchCard", usage: "核心", param: "query", output: "N 条(itemsCount;走 ResearchCard 时另有进度)", note: "capability(web-search)" },
  { name: "generateSvg", label: "生成配图", render: "GenerateSvgRow", usage: "核心", param: "—", output: "(走配图卡,非灰行)", note: "capability(image-gen)" },
  { name: "run_js", label: "运行JS脚本", render: "CommandCard(脚本卡)", usage: "核心", param: "—", output: "运行成功 / 运行失败(ok)", note: "capability(run-js) ← JS 工具,在用" },
  { name: "readMaterial", label: "读取素材", render: "通用灰行", usage: "核心", param: "materialId", output: "N 字(wordCount)", note: "会话作用域" },
  { name: "summarizeMaterial", label: "更新素材", render: "通用灰行", usage: "核心", param: "materialId", output: "已更新 / 未更新(updated)", note: "会话作用域" },
  { name: "readDraft", label: "读取草稿", render: "通用灰行", usage: "核心", param: "mode→中文", output: "N 字(wordCount),否则 N 块(blockCount)", note: "会话作用域" },
  { name: "editDraft", label: "修改草稿", render: "通用灰行", usage: "核心", param: "(无主参)", output: "改 N 处(hunkCount/appliedCount)/ 未改动(changed=false)", note: "会话作用域" },
  { name: "readDiff", label: "核对修改", render: "通用灰行", usage: "核心", param: "(无主参)", output: "N 处差异 / 无差异(stats.blocksChanged+marksChanged,后端已提升嵌套)", note: "会话作用域" },
  { name: "writeDraft", label: "生成草稿", render: "DraftMiniCard", usage: "核心", param: "—", output: "(走草稿卡,非灰行)", note: "会话作用域" },
  // —— 门控:代码确认注册,启用条件下在用 ——
  { name: "readImage", label: "识别图片", render: "ReadImageRow", usage: "门控", param: "—", output: "已识别 / 未识别(ok)", note: "capability(image-reading);有图片素材时" },
  { name: "show_qr", label: "扫码", render: "QrCard", usage: "门控", param: "—", output: "(走二维码卡)", note: "单独注入;授权/分享场景" },
  { name: "run_python", label: "运行Python脚本", render: "CommandCard", usage: "门控", param: "—", output: "运行成功 / 运行失败(ok)", note: "QINGAGENT_PYODIDE_ENABLED=1 且 pyodide 可用时(本环境关)" },
  { name: "skill", label: "激活技能", render: "通用灰行", usage: "门控", param: "skill→中文名", output: "已完成(无结构化数字)", note: "Mastra skills;skill_search 命中后" },
  { name: "skill_read", label: "读取技能", render: "通用灰行", usage: "门控", param: "skill→中文名", output: "已完成(Mastra 自由格式)", note: "Mastra skills" },
  { name: "skill_search", label: "搜索技能", render: "通用灰行", usage: "门控", param: "query", output: "已完成(Mastra 自由格式)", note: "Mastra skills;system.ts 明确引导调用" },
  { name: "mastra_workspace_execute_command", label: "运行命令", render: "CommandCard", usage: "门控", param: "—", output: "(走命令卡;Mastra 自由格式)", note: "沙箱;5 处引用" },
  { name: "mastra_workspace_read_file", label: "读取文件", render: "通用灰行", usage: "门控", param: "path→文件名", output: "已完成(Mastra 自由格式,无 wordCount)", note: "protected;4 处引用" },
  { name: "mastra_workspace_edit_file", label: "编辑文件", render: "通用灰行", usage: "门控", param: "path→文件名", output: "已完成(Mastra 自由格式)", note: "protected;4 处引用" },
  { name: "mastra_workspace_grep", label: "搜索文件", render: "通用灰行", usage: "门控", param: "pattern", output: "已完成(Mastra 自由格式)", note: "protected;5 处引用" },
  { name: "mastra_workspace_list_files", label: "列出文件", render: "通用灰行", usage: "门控", param: "path→文件名", output: "已完成(Mastra 自由格式)", note: "目录浏览;2 处引用" },
  { name: "mastra_workspace_write_file", label: "写入文件", render: "通用灰行", usage: "门控", param: "path→文件名", output: "已完成(Mastra 自由格式)", note: "1 处引用(少用)" },
  { name: "mastra_workspace_search", label: "搜索工作区", render: "通用灰行", usage: "门控", param: "query/pattern", output: "已完成", note: "protected;4 处引用" },
  { name: "readDocument", label: "读取文件", render: "通用灰行", usage: "门控", param: "path→文件名", output: "N 字(wordCount,项目自定义工具,字段对得上)", note: "folderDocuments;连本地文件夹数据源时" },
  { name: "searchDocuments", label: "搜索文件", render: "通用灰行", usage: "门控", param: "query", output: "N 条(resultsCount)", note: "folderDocuments;连数据源时" },
  { name: "browser_goto / snapshot / click / type / press / wait / scroll / back", label: "打开网页/浏览/点击…", render: "通用灰行", usage: "门控", param: "url→host / selector / direction→中文", output: "已完成(浏览器工具无结构化计数)", note: "QINGAGENT_AGENT_BROWSER 开启时;screenshot/evaluate/drag/tabs 已排除" },
  // —— 废弃:后端 0 emit / 0 引用,前端有分支但永不触发 ——
  { name: "mastra_workspace_delete", label: "删除文件", render: "(前端标签)", usage: "废弃", param: "—", output: "—", note: "后端 0 引用,前端臆造标签" },
  { name: "mastra_workspace_file_stat", label: "文件信息", render: "(前端标签)", usage: "废弃", param: "—", output: "—", note: "后端 0 引用,前端臆造标签" },
  { name: "mastra_workspace_mkdir", label: "新建目录", render: "(前端标签)", usage: "废弃", param: "—", output: "—", note: "后端 0 引用,前端臆造标签" },
  { name: "mastra_workspace_get_process_output", label: "读取进程输出", render: "(前端标签)", usage: "废弃", param: "(倒计时占位)", output: "(阻塞等待态,见 isProcOut)", note: "后端 0 引用,前端臆造标签" },
  { name: "mastra_workspace_kill_process", label: "终止进程", render: "(前端标签)", usage: "废弃", param: "—", output: "—", note: "后端 0 引用,前端臆造标签" },
];

// ═══════════ 死代码 / 不可达渲染(永远不会出现的样式),统一规范时应清理 ═══════════
interface DeadRef {
  where: string;
  branch: string;
  why: string;
  severity: "误导" | "冗余";
}
const DEAD_CODE: DeadRef[] = [
  {
    where: "ToolCallBody body.kind ×6",
    branch: "extractFile / extractImage / webFetch / browserOpen / browserAct / spawnSubAgent",
    why: "后端全 core 范围 0 emit(实测) → 前端 toolDisplayName 这 6 个 case(『解析文件/识别图片/获取网页/打开浏览器/浏览器操作/子任务』)+ ToolCallRow 分支永不触发。是契约里残留的旧表示法。",
    severity: "误导",
  },
  {
    where: "旧前端工具映射 ×5",
    branch: "mastra_workspace_delete / file_stat / mkdir / get_process_output / kill_process",
    why: "前端有中文标签,但后端全 core 范围 0 引用 → 这些工具不会被调用,标签是臆造的。",
    severity: "误导",
  },
  {
    where: "ChatMessageList renderToolSegs",
    branch: 'case "webSearch" / case "generateSvg"',
    why: "两者永远走专用卡(ResearchCard / GenerateSvgRow),到不了通用行;两段 seg 从不执行。",
    severity: "误导",
  },
  {
    where: "ChatMessageList renderToolSegs:1319",
    branch: 'case "parseFile" 读 a.filename',
    why: "parseFile 入参是 filePath(processAgentStream),a.filename 恒 undefined→段不显示,实际只剩裸标题。",
    severity: "误导",
  },
  {
    where: "ChatMessageList toolDisplayName",
    branch: "case writeDraftCard/commandCard/researchCard/qrCard/generateSvg/readImageCard",
    why: "这些 body.kind 在 ToolCallRow 上游已 return 各自专用卡,永远到不了旧 fallback 分支(冗余防御)。",
    severity: "冗余",
  },
];

const STATUS_REF: { kind: string; where: string; render: string }[] = [
  { kind: "pending", where: "工具已登记、未开始", render: "灰点 ·" },
  { kind: "running", where: "execute 进行中", render: "三点 loading (chat-loading-dots)" },
  { kind: "done", where: "成功完成", render: "灰勾 CheckIcon" },
  { kind: "failed", where: "工具抛错/非零退出", render: "中性灰停止图标 · 未完成；隐藏内部错误" },
  { kind: "aborted", where: "停止/抢占/断线收敛", render: "中性灰停止图标 · 已中止" },
];

// ═════════════════════════════════════════════════════════════════════════
// 一条真实写作对话(杭州亚运会观察报道),穿插正文,把所有元素串成自然对话流。
// 线上版 = ChatMessageList 直渲;改造版 = RevampStream(内联工具行→ImprovedToolRow,
// 卡片→真实组件 + 改造皮肤),两条流并排独立滚动,直接感受差异。
// ═════════════════════════════════════════════════════════════════════════
function tp(spec: ToolCallSpec): MessagePart {
  return { kind: "toolCall", data: spec };
}

function buildConvo(): ChatMessage[] {
  const now = Date.now();
  const attachChip: ChatChip = { kind: { kind: "attach" }, resourceRef: { id: "f1", domain: { kind: "file" } }, prefix: null, label: "赛事手册.pdf", suffix: null };
  const askQ: AskUserQuestion[] = [
    { id: "q1", label: "文章篇幅", kind: { kind: "slider" }, options: [], placeholder: null, slider: { min: 300, max: 2000, step: 100, unit: "字", marks: null, aboveLabel: "2000 字以上" } },
    { id: "q2", label: "目标读者", kind: { kind: "single" }, options: [{ value: "pro", label: "专业人士", description: null, preview: null }, { value: "public", label: "大众读者", description: null, preview: null }], placeholder: null },
    { id: "q3", label: "语气", kind: { kind: "text" }, options: [], placeholder: "如:正式 / 活泼" },
  ];
  const askAns: ToolCallResult = { kind: "askUserAnswers", data: { q1: { chosen: [], freeText: null, numericValue: 800 }, q2: { chosen: ["public"], freeText: null }, q3: { chosen: [], freeText: "专业但不晦涩" } } };

  return [
    userMsg("帮我写一篇杭州亚运会的观察报道，800 字左右，面向大众读者。素材见附件。 {{chip:0}}", [attachChip]),
    agentMsg([
      { kind: "thinking", data: { id: nid("th"), steps: ["用户要 800 字、面向大众的亚运观察。先读素材，再确认篇幅/读者/语气，然后写。"] } },
      { kind: "text", data: { body: "好的，我先把你上传的素材读一下，再和你确认几个方向。" } },
      tp(tool("parseFile", ST.done, genericBody({ filePath: "/uploads/赛事手册.pdf" }), genericResult({ wordCount: 8200 }))),
      tp(tool("readMaterial", ST.done, genericBody({ mode: "summary", materialId: "赛事手册" }))),
    ]),
    agentMsg([
      { kind: "text", data: { body: "素材读完了。动笔前先和你**对齐三个方向**：" } },
      tp(tool("askUser", ST.done, askUserBody(askQ), askAns)),
    ]),
    agentMsg([
      { kind: "text", data: { body: "明白——**面向大众、专业但不晦涩、约 800 字**。我再补两篇最新报道当素材。" } },
      tp(tool("webSearch", ST.done, researchBody("done", { total: 5, fetchedCount: 5, okCount: 4, skippedCount: 1, items: [{ url: "https://hangzhou2022.cn/a", title: "开幕式十大亮点", status: "done", wordCount: 1820 }, { url: "https://news.cn/b", title: "数字火炬手背后的技术", status: "done", wordCount: 990 }] }))),
      { kind: "image", data: { label: "开幕式十大亮点 · 杭州亚运会官网", src: TINY_SVG, srcKind: "url", sourceUrl: "https://hangzhou2022.cn/a", width: 160, height: 90 } },
      { kind: "image", data: { label: "数字火炬手背后的技术", src: null, srcKind: "url", sourceUrl: "https://news.cn/b", width: null, height: null } },
    ]),
    agentMsg([
      { kind: "text", data: { body: "素材齐了，我开始写初稿。" } },
      tp(tool("writeDraft", ST.done, draftBody("done", { charCount: 1180, excerpt: "本届亚运会的看点不止于金牌，更在于一座城市如何用科技与人文重新讲述自己。", lengthStatus: "accepted_first_pass", minLength: 800, maxLength: 1200 }))),
      { kind: "citation", data: { sourceRef: { id: "src-开幕式", domain: { kind: "source" } }, anchor: "2" } },
    ]),
    agentMsg([
      { kind: "text", data: { body: "初稿完成。开头是这样的：\n\n## 一城的盛会\n\n本届亚运会的看点**不止于金牌**，更在于一座城市如何用科技与人文重新讲述自己。从数字火炬手到智慧场馆，杭州把一届运动会，办成了一次城市表达。\n\n我顺手配了一张示意图：" } },
      tp(tool("generateSvg", ST.done, svgBody("done", { prompt: "杭州亚运会主场馆示意", src: TINY_SVG, width: 160, height: 90 }))),
    ]),
    agentMsg([
      { kind: "text", data: { body: "又做了两处润色，并核对了字数：" } },
      { kind: "patchSummary", data: { count: 2, hunkIds: ["hh"] } },
      tp(tool("run_js", ST.done, { kind: "commandCard", data: { title: "计算字数", icon: "🧮", command: "wc -m draft.md", exitCode: 0, outputTail: "1180", phase: "done" } })),
    ]),
    agentMsg([
      { kind: "text", data: { body: "配图存进了沙箱，并读回确认：" } },
      tp(tool("mastra_workspace_write_file", ST.done, genericBody({ path: "/work/assets/cover.svg" }), genericResult({ bytes: 2048 }))),
      tp(tool("mastra_workspace_read_file", ST.done, genericBody({ path: "/work/draft.md" }), genericResult({ bytes: 4096 }))),
    ]),
    agentMsg([
      { kind: "text", data: { body: "最后，发布到飞书文档需要你扫码授权：" } },
      tp(tool("show_qr", ST.done, qrBody({ expiresAt: now + 120000 }))),
    ]),
    agentMsg([
      { kind: "text", data: { body: "**初稿已完成**：约 800 字、面向大众、含一张示意配图，授权后即可一键发布到飞书。\n\n需要我调整语气，或补充「城市运营」这条线吗？" } },
    ]),
  ];
}

// 改造版用户气泡(统一:直角 + 中性底,与生产气泡同位但走统一皮肤)
function RevampMsg({ m }: { m: ChatMessage }) {
  if (m.role.kind === "system") return null;
  if (m.role.kind === "user") {
    const body = m.parts.find((p) => p.kind === "text");
    return (
      <div className="u-userwrap" data-wf="revamp-user">
        <div className="u-user">
          {body?.kind === "text" ? body.data.body.replace(/\s*\{\{chip:\d+\}\}\s*/g, " ") : ""}
          {m.chips?.map((c, i) => <span key={i} className="u-userchip">{c.label}{c.suffix ? ` · ${c.suffix}` : ""}</span>)}
        </div>
      </div>
    );
  }
  return (
    <div className="wf-msg agent" data-wf="revamp-agent">
      {m.parts.map((p, i) => <URevampPart key={i} part={p} />)}
    </div>
  );
}

// 改造版对话流:轮级折叠 demo —— 用户气泡 → 「过程 · N 步」折叠条 → 最终回复。
// 一轮 = 用户消息 + 之后全部 agent 内容;最终回复 = 最后一段 agent 正文;其余=过程,折起。
function RevampStream({ messages }: { messages: ChatMessage[] }) {
  const userMsg = messages.find((m) => m.role.kind === "user");
  const agentParts = messages.filter((m) => m.role.kind === "agent").flatMap((m) => m.parts);
  let lastTextIdx = -1;
  agentParts.forEach((p, i) => { if (p.kind === "text") lastTextIdx = i; });
  const processParts = lastTextIdx >= 0 ? agentParts.slice(0, lastTextIdx) : agentParts;
  const finalReply = lastTextIdx >= 0 ? agentParts[lastTextIdx] : null;
  return (
    <div className="ws-chat u-scope" data-wf="RevampStream">
      {userMsg && <RevampMsg m={userMsg} />}
      {processParts.length > 0 && <UTurnFold parts={processParts} />}
      {finalReply && <div className="wf-msg agent" data-wf="revamp-final"><URevampPart part={finalReply} /></div>}
    </div>
  );
}

// 备注本地实时存档(localStorage),刷新/热重载都不丢。
const NOTE_NS = "gxnote:";
function loadNote(key: string): string {
  try { return localStorage.getItem(NOTE_NS + key) ?? ""; } catch { return ""; }
}
function saveNoteEl(ta: HTMLTextAreaElement) {
  try {
    const k = ta.dataset.key ?? "";
    if (ta.value.trim()) localStorage.setItem(NOTE_NS + k, ta.value);
    else localStorage.removeItem(NOTE_NS + k);
  } catch { /* ignore */ }
}

// 备注快速选项:点一下追加到该行输入框,随「复制全部备注」一起导出。
const QUICK_TAGS = ["需要展开", "不需要展开", "改图标", "改间距", "改对齐", "改文案", "不用改", "用户定制", "废弃"];
function pickQuick(e: MouseEvent<HTMLButtonElement>) {
  const cell = e.currentTarget.closest(".gx-notecell");
  const ta = cell?.querySelector<HTMLTextAreaElement>(".gx-note");
  if (!ta) return;
  const label = e.currentTarget.textContent ?? "";
  ta.value = ta.value.trim() ? `${ta.value.trim()} [${label}]` : `[${label}]`;
  saveNoteEl(ta);
  ta.focus();
  // 标「不用改」→ 立即清空该行改进列(不等刷新)
  if (label === "不用改") {
    const imp = e.currentTarget.closest("tr")?.querySelectorAll(".gx-render")[1];
    if (imp) imp.innerHTML = '<span class="gx-settled">不用改（已确认）</span>';
  }
}

async function clearAllNotes(confirm: ReturnType<typeof useConfirm>) {
  const proceed = await confirm({
    title: "清空所有备注？",
    message: "本地存档也会一并清掉。",
    confirmLabel: "清空备注",
  });
  if (!proceed) return;
  document.querySelectorAll<HTMLTextAreaElement>(".gx-note").forEach((ta) => {
    ta.value = "";
    saveNoteEl(ta);
  });
}

function copyAllNotes(toast: ReturnType<typeof useToast>) {
  const notes = Array.from(document.querySelectorAll<HTMLTextAreaElement>(".gx-note"));
  const lines: string[] = [];
  for (const t of notes) {
    const v = t.value.trim();
    if (v) lines.push(`【${t.dataset.key}】\n${v}`);
  }
  if (lines.length === 0) {
    toast.show({ message: "还没填任何备注", tone: "warn" });
    return;
  }
  const text = lines.join("\n\n");
  const done = () => toast.show({
    message: `已复制 ${lines.length} 条备注，可直接粘给我`,
    tone: "success",
  });
  const copyWithTextarea = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    done();
  };
  const clipboardWrite = navigator.clipboard?.writeText(text);
  if (clipboardWrite) void clipboardWrite.then(done).catch(copyWithTextarea);
  else copyWithTextarea();
}

export function GalleryPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const groups = useMemo(() => buildGroups(), []);
  const convo = useMemo(() => buildConvo(), []);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <div id="view-workspace" className="gx-view" style={{ minHeight: "100vh", height: "100vh", overflow: "hidden" }}>
      <div className="ws-left gx-scope">
        <div className="gx-3col">
        <div className="gx-col-table">
          <div className="gx-copybar">
            <span className="gx-savehint">● 实时存档(localStorage)·刷新不丢</span>
            <button type="button" className="gx-clearbtn" onClick={() => void clearAllNotes(confirm)}>清空</button>
            <button type="button" className="gx-copybtn" onClick={() => copyAllNotes(toast)}>⧉ 复制全部备注</button>
          </div>
          <h1 className="gx-title">对话嵌入元素 · 多态画廊</h1>
          <p className="gx-sub">
            左列 = <b>全量多态大表</b>（现状 vs 改进 demo）；右侧两列是<b>独立滚动的真实对话流</b>——
            <b>线上版（现状）</b> vs <b>改造版（提案）</b>，穿插正文，直接感受差异。
            共 {groups.length} 组 / {total} 个状态。
          </p>

          <div className="gx-legend">
            <b>已知不统一点（扫"渲染"列即可见，附精确量化）</b>
            <div style={{ marginTop: 6 }}>
              ① <b>卡宽 / 圆角 / padding 各写各的</b>：Research/SVG <code>380px·radius0·body 10/12</code>、Command <code>320px·radius0·inline</code>、Draft 固定 <code>158px·radius?·9px 字</code>、Qr <code>padding16/18·白底·radius?</code>；
              <code>.askuser-card</code> 基础 radius10 被皮肤 <code>!important radius0</code> 直接冲突覆盖。
            </div>
            <div>② <b>样式落点分裂</b>：Research/SVG/Draft/AskUser 走 CSS class；CommandCard / 通用行 / code / patchSummary 走<b>内联 style</b>（散落在 ChatMessageList 各分支）；流级错误已迁入 <code>.qa-toast</code>。</div>
            <div>③ <b>字号无层级</b>：agent 13.5 / user 13 / 通用行 13 / Research 12·10.5 / Draft 9·10.5·8.5 / LinkCard 13·11.5 / AskUser 12.5 —— 没有统一刻度。</div>
            <div>④ <b>图标混用</b>：CheckIcon <code>12/15/16/17/18</code> 五种尺寸；CommandCard 用 emoji（🧮📤）、Qr 用 <code>↻ 22px</code> 文本符、Chip 用 <code>❝📎@</code>、thinking 用 <code>▸▾</code>、patch 用 <code>●✗!</code>。</div>
            <div>⑤ <b>loading 四套表达</b>：三点 <code>.chat-loading-dots</code> / Research+SVG 圆环 <code>.rs-ring</code> / AskUser skeleton shimmer / Qr 纯文字「生成中…」。</div>
            <div>⑥ <b>失败态语义不一</b>：通用行 + ReadImage <b>failed=done 同形（灰勾，不暴露失败）</b>；Command 金色「失败」、Draft 红「生成失败」、SVG 红「!」；流级失败现归并为底部常驻 <code>.qa-toast.error</code>。</div>
            <div>⑦ <b>历史未映射工具 fallback 成裸『工具调用』</b>：readDocument / searchDocuments / mastra_workspace_search 现已统一进 <code>TOOL_LABELS</code>。</div>
            <div style={{ marginTop: 6, color: "var(--ink-2)" }}>
              ⑧ <b>大量工具「仅标题、无参数」</b>，看不出对哪个文件/对象操作（全部 <code>mastra_workspace_*</code> 文件工具、editDraft/readDraft 等）。底层 <code>argsJson</code>(输入)+<code>result</code>(输出) 早在前端手里 →
              <b style={{ color: "#c8a96a" }}> 右侧「改进后 demo」列是真实拼出的修复版</b>（暴露主参数 + 输出概要 + 失败态 + ▸详情），与现状并排对比。每个渲染框已锁成<b>真实对话容器宽度</b>。
            </div>
          </div>

          <table className="gx-table">
            <thead>
              <tr>
                <th className="gx-col-no">#</th>
                <th className="gx-col-state">状态</th>
                <th className="gx-col-copy">文案 / 当前参数</th>
                <th className="gx-col-render">现状渲染（真实）</th>
                <th className="gx-col-render">改进后 demo（真实拼）</th>
                <th className="gx-col-note">我的评价（逐行填，顶部「复制全部备注」一键导出）</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                let n = 0;
                return (
                  <GroupBody key={g.title} group={g} indexFn={() => ++n} />
                );
              })}
            </tbody>
          </table>

          <h2 className="gx-title" style={{ fontSize: 17, marginTop: 40 }}>附 1 · ToolCallStatus 全量状态码</h2>
          <table className="gx-table" style={{ marginTop: 10 }}>
            <thead>
              <tr><th>status.kind</th><th>何时</th><th>渲染</th></tr>
            </thead>
            <tbody>
              {STATUS_REF.map((s) => (
                <tr key={s.kind}>
                  <td><code className="gx-state-kind">{s.kind}</code></td>
                  <td className="gx-copy">{s.where}</td>
                  <td className="gx-copy">{s.render}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 className="gx-title" style={{ fontSize: 17, marginTop: 40 }}>
            附 2 · 全量工具 · 在用审计（{TOOL_AUDIT.length} 个，运行时 /api/v1/debug/tools + 后端 emit 核实）
          </h2>
          <p className="gx-sub" style={{ marginBottom: 10 }}>
            <b style={{ color: "#7fb88a" }}>核心</b> = 运行时确认注册；<b style={{ color: "#d8b56a" }}>门控</b> = 代码确认注册、能力/会话/资料库门控启用；
            <b style={{ color: "#e0866a" }}>废弃</b> = 后端 0 emit / 0 引用，前端有分支/标签但永不触发（红行）。"光在代码里存在 ≠ 会被调用"。
          </p>
          <table className="gx-table" style={{ marginTop: 4 }}>
            <thead>
              <tr><th>工具 name</th><th>label</th><th>渲染</th><th>在用</th><th>主参数位</th><th>完成态状态文案</th><th>证据 / 门控</th></tr>
            </thead>
            <tbody>
              {TOOL_AUDIT.map((t) => {
                const bg = t.usage === "废弃" ? "rgba(216,56,43,0.12)" : t.usage === "门控" ? "rgba(216,181,106,0.08)" : undefined;
                const uColor = t.usage === "核心" ? "#7fb88a" : t.usage === "门控" ? "#d8b56a" : "#e0866a";
                return (
                  <tr key={t.name} style={{ background: bg }}>
                    <td><code className="gx-state-kind">{t.name}</code></td>
                    <td className="gx-copy">{t.label}</td>
                    <td className="gx-copy">{t.render}</td>
                    <td className="gx-copy" style={{ color: uColor, fontWeight: 700 }}>{t.usage}</td>
                    <td className="gx-copy">{t.param}</td>
                    <td className="gx-copy">{t.output}</td>
                    <td className="gx-src">{t.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h2 className="gx-title" style={{ fontSize: 17, marginTop: 40 }}>
            附 3 · 死代码 / 不可达渲染（永远不会出现的样式，应清理）
          </h2>
          <table className="gx-table" style={{ marginTop: 10 }}>
            <thead>
              <tr><th>位置</th><th>分支</th><th>为何不可达</th><th>性质</th></tr>
            </thead>
            <tbody>
              {DEAD_CODE.map((d, i) => (
                <tr key={i} style={{ background: d.severity === "误导" ? "rgba(216,56,43,0.1)" : undefined }}>
                  <td className="gx-src">{d.where}</td>
                  <td className="gx-copy"><code className="gx-state-kind">{d.branch}</code></td>
                  <td className="gx-copy">{d.why}</td>
                  <td className="gx-copy">{d.severity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="gx-col-stream" data-variant="live">
          <div className="gx-stream-head">
            线上版 · 现状
            <span className="gx-stream-sub">真实 ChatMessageList 直渲</span>
          </div>
          <ChatMessageList messages={convo} streamActive={false} debugMode />
        </div>

        <div className="gx-col-stream gx-revamp-col" data-variant="revamp">
          <div className="gx-stream-head gx-stream-head--revamp">
            改造版 · 提案
            <span className="gx-stream-sub">内联工具行→暴露参数 · 卡片统一皮肤</span>
          </div>
          <RevampStream messages={convo} />
        </div>
        </div>
      </div>
    </div>
  );
}

function GroupBody({ group, indexFn }: { group: Group; indexFn: () => number }) {
  return (
    <>
      <tr className="gx-group-row">
        <td colSpan={6}>
          {group.title}
          <span className="gx-group-meta">{group.meta}</span>
        </td>
      </tr>
      {group.rows.map((r, i) => {
        const n = indexFn();
        const short = group.title.split(" ")[0];
        // 数据驱动:备注里标了「不用改」→ 该行改进列清空,标成已确认(避免后面忘了)。
        const settled = /不用改/.test(loadNote(`${short} · ${r.state}`));
        return (
          <tr key={i}>
            <td className="gx-col-no">{n}</td>
            <td>
              <div className="gx-state-name">{r.state}</div>
              {r.code && <div className="gx-state-kind">{r.code}</div>}
            </td>
            <td className="gx-copy">{r.copy}</td>
            <td className="gx-render">{r.render}</td>
            <td className="gx-render">
              {group.deprecated
                ? <span className="gx-dead-note">✗ 废弃 · {group.deprecated}</span>
                : group.customNote
                  ? <span className="gx-custom-note">⌁ 用户定制 · {group.customNote}</span>
                  : settled
                    ? <span className="gx-settled">不用改（已确认）</span>
                    : (r.improved ?? <span className="gx-copy-empty">—</span>)}
            </td>
            <td className="gx-notecell">
              <textarea
                className="gx-note"
                data-key={`${short} · ${r.state}`}
                defaultValue={loadNote(`${short} · ${r.state}`)}
                onInput={(e) => saveNoteEl(e.currentTarget)}
                placeholder="写评价…"
                rows={2}
              />
              <div className="gx-quick">
                {QUICK_TAGS.map((q) => (
                  <button key={q} type="button" className="gx-qtag" onClick={pickQuick}>{q}</button>
                ))}
              </div>
              <div className="gx-srcline" title={r.src}>{r.src}</div>
            </td>
          </tr>
        );
      })}
    </>
  );
}
