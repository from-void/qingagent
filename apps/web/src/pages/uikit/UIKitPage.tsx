import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { ChatMessage, FolderSource, MessagePart, Resource } from "@qingagent/contract-ts";
import {
  UAskUser,
  UCommand,
  UDraft,
  UQr,
  UResearch,
  USvg,
  UToolBar,
  UTurnFold,
} from "../gallery/revampUi";
// 审核态 / 修订 / 来源 / 图表块 / 版本 toast 一律直接取生产组件(单一真源),不再用画廊 demo 表示。
import { ChatMessageList } from "../workspace/components/ChatMessageList";
import type { ChatMessageListProps } from "../workspace/components/ChatMessageList";
import { ReviewOutcomeCard } from "../workspace/components/ReviewOutcomeCard";
import { BrowserViewPart } from "../workspace/components/BrowserViewPart";
import { DiagramRenderer } from "../workspace/components/diagram/DiagramRenderer";
// —— 本页真实引用的生产组件(mock props 驱动,零重写)——
import { BigPlanPanel } from "../workspace/components/BigPlanPanel";
import { PatchNav } from "../workspace/components/PatchNav";
import { WholeDocReviewNav } from "../workspace/components/WholeDocReviewNav";
import { LinkedFilesPanel } from "../workspace/components/LinkedFilesPanel";
import type { MaterialParseRow } from "../workspace/data/useMaterialParseTracker";
import { SkillMenu } from "../../system/SkillMenu";
import type { SkillMenuAction } from "../../system/SkillMenu";
// 现役唯一模态:AuthTokenGate(真组件收录,ToastProvider 供其 useToast;
// forceOpen 走 demo 隔离,不监听全局 401 事件;.wf-modal 是 absolute 定位,uk-portal 即可圈住)
import { AuthTokenGate } from "../../system/AuthTokenGate";
import { ToastProvider } from "../../system/ToastProvider";
import {
  ST,
  askA,
  askQ,
  bigPlanSpec,
  cmdDone,
  diagramFlowchart,
  diagramSequence,
  draftDone,
  generic,
  gres,
  processParts,
  qrData,
  researchDone,
  reviewAllAccepted,
  reviewAllRejected,
  reviewMixed,
  sourceImageNoThumb,
  sourceImageWithThumb,
  svgDone,
  tool,
} from "./uikitMocks";
import coverageResult from "./coverageResult.json";
import "../workspace/workspace.css";
import "../workspace/components/DiagramView.css";
import "../workspace/components/ImageView.css";
import "../workspace/components/diagram/graphDiagram.css";
import "../workspace/workspace-ink-skin.css";
import "../home/home.css";
import "../home/components/qingjian.css";
import "../../overlays/settings/settings.css";
import "../../overlays/settings/modelDashboard.css";
import "../../system/skill-menu.css";
import "../../system/folder-control.css";
import "../../system/longText.css";
import "./uikit.css";
import "./uikit-archive.css";
import "./uikit-dig.css";

// —— 第一/二/三层用到的本页局部 mock 数据 ——
const skillActions: SkillMenuAction[] = [
  { id: "s-search", label: "联网搜索", description: "查资料、找事实、补背景", placeholder: "搜索…", icon: "search" },
  { id: "s-browse", label: "打开网页", description: "抓取指定链接的正文", placeholder: "网址…", icon: "browser" },
  { id: "s-image", label: "生成配图", description: "按描述画一张线稿示意图", placeholder: "画…", icon: "image" },
  { id: "s-vision", label: "识图", description: "读懂上传的图片内容", placeholder: "看图…", icon: "vision" },
  { id: "s-publish", label: "导出到飞书", description: "把成稿发到飞书文档", placeholder: "发布…", icon: "feishu" },
];
// dev-only 类簇「迁出候选」——随 dev 工具页迁 ops 仓,不删(用户拍板)。
const MIGRATE: Array<[string, string]> = [
  ["uk-*", "本 UI 规范活页自有脚手架(#/uikit)"],
  ["sp-*", "组件规范演示页(#/spec)脚手架(#/uikit 禁止活 DOM 引用)"],
  ["gx-*", "对话元素画廊(#/gallery)脚手架"],
  ["dbg-*", "调试页(#/debug)脚手架"],
  ["u-user / 身份装饰 …", "画廊/规范页示例用的对话 mock 装饰"],
];

const DIG_DEV_ONLY: Array<[string, number, string, string]> = [
  ["gallery gx-* / rs/svg 画廊资产", 58, "#/gallery", "留,或随开发工具迁 ops"],
  ["debug dbg-* 调试页资产", 15, "#/debug", "留,或随调试页迁 ops"],
  ["workspace tuning panel / ptp-*", 14, "工作区调参入口", "留 dev-only,迁 ops 更干净"],
  ["spec demo sp-* 资产", 13, "#/spec", "留规范演示页或迁 ops"],
  ["workspace morph debug panel / mdp-*", 13, "工作区 morph 调试入口", "留 dev-only,迁 ops 更干净"],
  ["其他 dev-only 资产", 13, "#/gallery / 工作区 dev 态", "逐项确认,不当死件删"],
  ["gallery revamp u-* 对话变体", 12, "#/gallery", "画廊库存变体,迁库文档"],
  ["uikit 展厅自有非 uk 小样式", 6, "#/uikit", "展厅自有,显式豁免"],
  ["home qj-ink-debug 调参器", 5, "首页调参开关", "留 dev-only,迁 ops 更干净"],
  ["workspace ctx-debug-float 调试浮层", 1, "工作区 debug 浮层", "留 dev-only 或迁 ops"],
];

const DIG_ACTIVE_CANDIDATES: Array<[string, number, string, string, string]> = [
  ["GraphDiagram / ReactFlow 图表编辑器", 48, "GraphDiagramView.tsx:317/1717", "reachable / suspectedUnderSampled", "收编图编辑四域,或条件白名单"],
  ["Settings/ModelDashboard 条件界面", 44, "ModelSettingsPanel.tsx:452/707", "reachable / suspectedUnderSampled", "设置域收编,已有部分 conditionalLive"],
  ["Home Qingjian 动态场景/设置件", 42, "QingjianScroll.tsx:2491", "reachable / suspectedUnderSampled", "首页场景态单列豁免"],
  ["chatUnified u-* 对话内容件", 38, "chatUnified.tsx:525", "reachable / suspectedUnderSampled", "收编对话内容件"],
  ["AskUser 问卷/权限浮层 au/askuser", 37, "ChatMessageList.tsx:774", "reachable / suspectedUnderSampled", "收编问卷/权限弹层"],
  ["代码块/数学/lowlight 生成类", 31, "CodeBlockView.tsx:177", "reachable + third-party runtime", "编辑器域或第三方生成豁免"],
  ["Workspace 条件状态/链接/全篇审阅", 30, "WholeDocReviewNav.tsx:103", "reachable / suspectedUnderSampled", "状态修饰归属对应组件"],
  ["编辑器 chrome / toolbar 条件件", 27, "DocumentSnapshotView.tsx:1370", "reachable / suspectedUnderSampled", "编辑器域收编"],
  ["NewSession 青简门板/汉字面板", 24, "HanziMatrixPanel.tsx:52", "reachable / suspectedUnderSampled", "整页场景态豁免"],
  ["StarterPanel 新建模板 starter-*", 18, "StarterPanel.tsx:144", "reachable / suspectedUnderSampled", "收编新建模板面板"],
  ["LinkedFilesPanel 已关联文件 lf-*", 15, "LinkedFilesPanel.tsx:253", "reachable / newlyCataloged", "§29 已收编;AssetPanel 旧网格已退役"],
  ["Home book/search/delete 条件界面", 14, "BookCurlShelf.tsx:511", "reachable / suspectedUnderSampled", "首页条件态收编"],
  ["QrCard 登录卡", 12, "QrCard.tsx:86", "reachable / suspectedUnderSampled", "收编登录卡"],
  ["AssetPreview 文件右预览 fd-rp-*", 11, "AssetPreview.tsx:56", "reachable / suspectedUnderSampled", "收编文件预览"],
  ["patch-popup", 10, "DocumentSnapshotView.tsx:4831", "test/dead 噪声但生产条件渲染命中", "收编审核 diff 条件弹层"],
  ["LongText 长文本弹层 lt-*", 9, "longText.tsx:151", "reachable / suspectedUnderSampled", "收编系统长文本弹层"],
  ["MediaZoom 全屏预览", 8, "MediaZoomFullscreen.tsx:115", "reachable / suspectedUnderSampled", "收编媒体预览"],
  ["FolderSourceControl popover 态", 7, "FolderSourceControl.tsx:424", "reachable / suspectedUnderSampled", "已有部分 conditionalLive"],
  ["移动端提示 / nokey 强制态", 7, "modelKeyGate.tsx:71", "reachable / suspectedUnderSampled", "收编运行时门禁"],
  ["审核 diff 条件渲染类", 5, "DocumentSnapshotView.tsx:4157", "条件渲染 / test 采样噪声", "收编 diff 状态"],
];

// —— 现役对话流单一真源:把 MessagePart 交给生产 ChatMessageList 真实分发路径渲染 ——
// 用于 patchSummary(已修改 N 处 / 待确认 / 整篇改写 / 已放弃)与引用块等「非独立导出」的
// 内联态,避免在本页重写它们的标记(改了生产,这里同步变)。
function Live({
  parts,
  role = "agent",
  ...rest
}: { parts: MessagePart[]; role?: "agent" | "user" } & Partial<ChatMessageListProps>) {
  const msg: ChatMessage = {
    id: `uk-${rest.liveHunkKey ?? parts.map((p) => p.kind).join()}`,
    role: { kind: role },
    ts: "",
    parts,
    chips: null,
  };
  return <ChatMessageList messages={[msg]} streamActive={false} {...rest} />;
}

// §25 真 AuthTokenGate 陈列:forceOpen 仅展示真实 Modal 视觉,不监听/读写 authGate 全局 pending。
// 关闭/提交都走本地 no-op 反馈,避免 #/uikit 打开期间抢真实 401。
function AuthGateDemo() {
  return (
    <ToastProvider>
      <AuthTokenGate forceOpen />
    </ToastProvider>
  );
}

const linkedFilesFolderSource: FolderSource = {
  id: "uk-linked-folder",
  sessionId: "uk-session",
  provider: "desktop-local",
  name: "客户资料",
  pathLabel: "~/Documents/客户资料",
  mountName: "source_customers",
  mountPath: "/sources/source_customers",
  readOnly: true,
  fileCount: 14,
  fileCountCapped: false,
  status: "connected",
  error: null,
  createdAt: "2026-07-04T00:00:00.000Z",
  updatedAt: "2026-07-04T00:00:00.000Z",
};

const linkedFilesMaterialRows: MaterialParseRow[] = [
  linkedFilesReadyRow("uk-resource-brief", "赛事手册.pdf", "application/pdf", 8200),
  linkedFilesReadyRow(
    "uk-resource-interview",
    "采访提纲.md",
    "text/markdown",
    3120,
  ),
];

const linkedFilesEntries: Record<string, { entries: Array<{ name: string; kind: "dir" | "file"; childCount: number | null; byteLen: number | null }>; truncated: boolean }> = {
  "": {
    entries: [
      { name: "现场照片", kind: "dir", childCount: 3, byteLen: null },
      { name: "预算测算.xlsx", kind: "file", childCount: null, byteLen: 34816 },
      { name: "开幕式主视觉.png", kind: "file", childCount: null, byteLen: 260112 },
    ],
    truncated: false,
  },
  "现场照片": {
    entries: [
      { name: "入场通道.jpg", kind: "file", childCount: null, byteLen: 183204 },
      { name: "颁奖台.webp", kind: "file", childCount: null, byteLen: 156440 },
    ],
    truncated: false,
  },
};

function linkedFilesReadyRow(id: string, filename: string, mime: string, byteLen: number): MaterialParseRow {
  const resource: Resource = {
    resourceRef: { id, domain: { kind: "file" } },
    displayName: filename,
    summary: "",
    mime,
    byteLen,
    createdAt: "2026-07-04T00:00:00.000Z",
    metadata: { fileId: `file-${id}` },
  };
  return {
    id,
    fileId: `file-${id}`,
    filename,
    mime,
    state: "ready",
    parseError: null,
    resource,
    source: "resource",
  };
}

function LinkedFilesPanelDemo() {
  const [mockReady, setMockReady] = useState(false);

  useEffect(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (input, init) => {
      const rawUrl = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const url = new URL(rawUrl, window.location.origin);
      if (url.pathname.includes("/folder-sources/") && url.pathname.endsWith("/entries")) {
        const relPath = url.searchParams.get("path") ?? "";
        const body = linkedFilesEntries[relPath] ?? { entries: [], truncated: false };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;
    setMockReady(true);
    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  const noop = () => {};
  if (!mockReady) return null;

  return (
    <div className="uk-linkedfiles-grid">
      <div className="uk-linkedfiles-sample">
        <span className="uk-cap">收起细条摘要态</span>
        <LinkedFilesPanel
          materialRows={linkedFilesMaterialRows}
          folderSource={linkedFilesFolderSource}
          onReference={noop}
          onAttachFolder={noop}
          onDetachFolder={noop}
        />
      </div>
      <div className="uk-linkedfiles-sample">
        <span className="uk-cap">展开树态</span>
        <LinkedFilesPanel
          materialRows={linkedFilesMaterialRows}
          folderSource={linkedFilesFolderSource}
          locateFolderSignal={1}
          onReference={noop}
          onPreviewFolderFile={noop}
          onAttachFolder={noop}
          onDetachFolder={noop}
        />
      </div>
    </div>
  );
}

function EyeGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

// patchSummary 带「本轮候选已放弃」运行时字段(getPatchSummaryReviewOutcome 读它)。
function abandonedPatchPart(): MessagePart {
  return { kind: "patchSummary", data: { count: 3, hunkIds: ["ab-1"], reviewOutcome: "abandoned" } } as MessagePart;
}

// ──────────────────────────────────────────────────────────────────────────
// 全站 UI 控件规范(#/uikit · dev-only)。
// 目标:把全站控件用「真实类名 + 真实 CSS/token」分类陈列,作为后续迭代的对标基准。
// 控件样式一律取自全站(wf-* 设计系统 / pm-* 编辑器 / ws-* 工作区 …),本页不重写控件,
// 只提供展厅脚手架(uk-*)。改了某控件的全站 CSS,这里会同步变化 —— 这就是「活页规范」。
// ──────────────────────────────────────────────────────────────────────────

// —— 展厅脚手架小组件 ——
function Section({ idx, zh, en, id, children }: { idx: string; zh: string; en: string; id: string; children: ReactNode }) {
  return (
    <section className="uk-section" id={id}>
      <h2>
        <span className="uk-idx">{idx}</span>
        {zh}
        <span className="uk-en">{en}</span>
      </h2>
      {children}
    </section>
  );
}
function Group({ title, code, children }: { title: string; code?: string; children: ReactNode }) {
  return (
    <div className="uk-group">
      <h3>
        {title}
        {code ? <code>{code}</code> : null}
      </h3>
      <div className="uk-stage">{children}</div>
    </div>
  );
}
function Cell({ cap, children }: { cap: string; children: ReactNode }) {
  return (
    <div className="uk-cell">
      {children}
      <span className="uk-cap">{cap}</span>
    </div>
  );
}
function ExportGlyph() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="M8 7l4-4 4 4" />
      <path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
    </svg>
  );
}

// —— token 数据(当前「暖纸·金」主题,取自生产 workspace-ink-skin.css 暖化覆盖)——
// 注:基础 tokens.css 是旧的冷绿灰 + 暗红 mark,已被全站暖化,故此处记录的是「当下真实皮肤」。
const COLOR_GROUPS: Array<{ title: string; tokens: Array<[string, string, boolean?]> }> = [
  {
    title: "背景 background · 奶白纸",
    tokens: [
      ["--bg-canvas", "#faf6ec"],
      ["--bg-paper-deep", "#efe7d6"],
      ["--bg-window", "#e7ddc9"],
      ["--bg-subtle", "rgba(120,90,50,.07)"],
      ["--bg-hover", "rgba(120,90,50,.10)"],
    ],
  },
  {
    title: "线条 line · 暖棕",
    tokens: [
      ["--line-1", "rgba(120,90,50,.16)"],
      ["--line-2", "rgba(120,90,50,.28)"],
      ["--line-3", "rgba(120,90,50,.42)"],
      ["--line-ink", "#2f2a22"],
    ],
  },
  {
    title: "墨色 ink · 暖深棕",
    tokens: [
      ["--ink-1", "#2f2a22"],
      ["--ink-2", "#5c5346"],
      ["--ink-3", "#8a7f6e"],
      ["--ink-4", "#b3a791"],
      ["--ink-on-dark", "#ece3d0", true],
    ],
  },
  {
    title: "强调 mark · 金铜",
    tokens: [
      ["--mark", "#a8823f"],
      ["--mark-soft", "rgba(168,130,63,.14)"],
      ["--sel-bg", "#f1e4a8"],
    ],
  },
  {
    title: "暗墨 chrome(对话区深色面)",
    tokens: [
      ["--ink-surface", "#1a1410"],
      ["--ink-surface-2", "#221c15"],
      ["--mark(暗)", "#b59a63"],
      ["--ink-1(暗)", "#ece3d0", true],
    ],
  },
];

// 铁律一「全宋」:字体只有三个角色。--font-sans 从「正文」降级为「受限」——
// 仅 12px 以下 meta 小字允许(宋体小字号笔画糊是唯一保 sans 的理由)。
const FONTS: Array<[string, string, string]> = [
  ["--font-zh-serif", "宋体系 · 一切中文 UI(铁律一)", "青简成章 · 标题、正文、按钮、菜单皆宋"],
  ["--font-display", "展示衬线 · 西文与数字混排标题", "青简 Design Tokens"],
  ["--font-mono", "等宽 · 数字/代码/路径/键帽", "const ink = '#2f2a22'; // 1,234"],
  ["--font-sans", "无衬线 · 仅 <12px meta 小字(受限)", "10.5px 辅助小字才允许出现"],
];

// 全库现存 8+ 套字体写法 → 3 个角色 token 的收敛映射(清洗阶段照此批量替换)。
const FONT_MAP: Array<[string, string, string]> = [
  ["--ccx-serif(新建页自造)", "→ --font-zh-serif", "废止"],
  ["--home-songti(首页自造)", "→ --font-zh-serif", "废止"],
  ["--qj-font-secondary", "→ --font-zh-serif", "废止"],
  ["--cm-font-title", "→ --font-display", "废止"],
  ['裸写 "Noto Serif SC"', "→ --font-zh-serif", "字面量收编进 token"],
  ["QingYanShiSubset(首页题字)", "保留", "装饰字型白名单,仅限题字"],
  ["--font-sans(现 32 处)", "逐处审查", "≥12px 一律改宋"],
  ["ui-kit 基座 components.css 8 处 sans", "→ --font-zh-serif", "非宋的总根源:按钮/chip/输入/任务行/浮动菜单行等基类写死 sans,页面各自用皮肤覆盖救,覆盖不到就漏。基座统一改宋"],
];

// 铁律二「默认直角」:圆角不再是尺寸阶梯,是白名单。写 border-radius 前三问——
// 是 chip/药丸?是头像/圆点?是对话气泡?三问皆否 → 0。
const RADIUS_ALLOW: Array<[string, string, string]> = [
  ["默认", "0", "按钮 / 输入框 / 菜单 / 弹层 / 卡片 / Toast"],
  ["--r-pill", "999px", "chip · 药丸 · 导航胶囊"],
  ["50%", "50%", "头像 · 圆点指示"],
  ["气泡角", "6px", "对话气泡(唯一保留的软角)"],
];
const RADIUS_DEPRECATED: Array<[string, string]> = [
  ["--r-sm", "4px"],
  ["--r", "8px"],
  ["--r-lg", "14px"],
];
const SHADOWS: Array<[string, string]> = [
  ["--shadow-1", "细"],
  ["--shadow-2", "中"],
  ["--shadow-3", "深"],
];

// 导航按真实界面四域重组:首页域 / 文档页左对话流 / 右编辑器 / 底部输入区。
const NAV: Array<{ group: string; items: Array<[string, string]> }> = [
  { group: "总则", items: [["rules", "铁律 · 决策规则"]] },
  {
    group: "Token",
    items: [
      ["t", "颜色(暖纸·金)"],
      ["type", "字体(全宋)"],
      ["shape", "直角 · 阴影"],
    ],
  },
  {
    group: "基础原子(跨域字母表)",
    items: [
      ["btn", "按钮"],
      ["chip", "标签/徽标"],
      ["profile", "头像"],
      ["card", "卡片/区域"],
    ],
  },
  {
    group: "域一 · 首页",
    items: [
      ["home-float", "首页浮动入口"],
      ["home-settings", "首页设置控件"],
      ["home-menus", "首页菜单与确认"],
    ],
  },
  {
    group: "域二 · 文档页 — 对话流(左栏)",
    items: [
      ["msg", "消息气泡"],
      ["chat", "现役对话组件"],
      ["review", "审核态回流"],
      ["bigplan", "开场问卷 BigPlan"],
      ["ink", "泼墨气泡"],
    ],
  },
  {
    group: "域二 · 文档页 — 编辑器(右栏)",
    items: [
      ["doc", "文档元素"],
      ["seltoolbar", "选中/块工具条"],
      ["blockhandle", "块手柄与菜单"],
      ["inlinepop", "行内浮层"],
      ["tableedit", "表格编辑件"],
      ["imageblock", "图片块"],
      ["diagram", "图表工具栏"],
      ["diagramblock", "图表块"],
      ["diagramedit", "图表块编辑件"],
      ["patchsys", "修订审批系"],
    ],
  },
  {
    group: "域二 · 文档页 — 输入区(底部)",
    items: [
      ["input", "输入"],
      ["send", "发送/停止/门禁"],
      ["menu", "菜单/浮层"],
      ["asset", "已关联文件"],
    ],
  },
  { group: "域三 · 顶栏 · 导出", items: [["export", "导出菜单"]] },
  {
    group: "域四 · 全局反馈",
    items: [
      ["toast", "Toast(统一家族)"],
      ["overlay", "弹层/抽屉"],
    ],
  },
  {
    group: "附录 · 原子矩阵(每变体锚真实使用点)",
    items: [
      ["btnmatrix", "按钮全矩阵"],
      ["inputatom", "输入区原子"],
      ["menuatom", "菜单浮层原子"],
      ["misc", "杂项原子"],
    ],
  },
  {
    group: "档案边界",
    items: [
      ["cond", "现役·条件变体"],
      ["task", "任务(已移除)"],
      ["dead", "死件档案"],
      ["migrate", "迁出候选"],
      ["coverage", "覆盖率校验"],
    ],
  },
];

type ButtonMatrixSample = {
  className: string;
  label: string;
  text: string;
  cap: string;
  disabled?: boolean;
};
const BTN_MATRIX_GROUPS: Array<{ title: string; code: string; dark?: boolean; samples: ButtonMatrixSample[] }> = [
  {
    title: "浅纸 / 弹层",
    code: "AuthTokenGate · RightPane",
    samples: [
      { className: "wf-btn primary", label: "primary", text: "提交", cap: "primary · AuthTokenGate 提交令牌" },
      { className: "wf-btn ghost", label: "ghost", text: "取消", cap: "ghost · AuthTokenGate 取消" },
      { className: "wf-btn small", label: "small", text: "采纳全部", cap: "small · RightPane 全部采纳" },
      { className: "wf-btn small ghost", label: "small ghost", text: "放弃全部", cap: "small ghost · RightPane 全部放弃" },
    ],
  },
  {
    title: "暗墨 chrome / 文档页",
    code: "BigPlanPanel · ChatInput",
    dark: true,
    samples: [
      { className: "wf-btn primary", label: "primary", text: "确认方向", cap: "primary · BigPlanPanel 确认方向" },
      { className: "wf-btn ghost", label: "ghost", text: "问我更多", cap: "ghost · BigPlanPanel 问我更多/放弃本轮" },
      { className: "wf-btn primary small", label: "primary small", text: "发送 →", cap: "primary small · ChatInput 发送按钮" },
      { className: "wf-btn small ghost", label: "small ghost", text: "技能", cap: "small ghost · ChatInput 技能/文件/文件夹/停止" },
      { className: "wf-btn primary small", label: "disabled", text: "发送 →", cap: ":disabled · ChatInput 未配置 key / BigPlanPanel 未就绪", disabled: true },
    ],
  },
];
const BTN_MATRIX_TOMBSTONES = [
  ".wf-btn",
  ".wf-btn.lg",
  ".wf-btn.primary.lg",
  ".wf-btn.ghost.lg",
  ".wf-btn.square",
  ".wf-btn.primary.square",
  ".wf-btn.ghost.square",
  ".wf-btn.icon",
  ".wf-btn.primary.icon",
  ".wf-btn.ghost.icon",
];

export function UIKitPage() {
  return (
    <div id="uikit-root" className="uk-root">
      <div className="uk-top">
        <h1>青简 · UI 规范</h1>
        <span className="uk-sub">qingagent design system</span>
        <span className="uk-meta">#/uikit · 铁律 → Token → 场景 · 真类名活页</span>
      </div>

      <div className="uk-body">
        <nav className="uk-nav">
          {NAV.map((g) => (
            <div className="uk-nav-group" key={g.group}>
              <span className="uk-nav-glbl">{g.group}</span>
              {g.items.map(([id, label]) => (
                <a
                  key={id}
                  href={`#${id}`}
                  onClick={(e) => {
                    // hash 路由 SPA 里页内锚点会劫持路由(#toast 被当路由跳走),改 JS 滚动、不动 hash。
                    e.preventDefault();
                    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  {label}
                </a>
              ))}
            </div>
          ))}
        </nav>

        {/* ══════════════ 总则 / Token / 基础原子 ══════════════ */}

        {/* 0. 铁律 · 决策规则 —— 规范的入口:先过规则,再挑组件 */}
        <Section idx="00" zh="铁律 · 决策规则" en="Rules first" id="rules">
          <p className="uk-cap uk-lead">
            新做任何界面先过这四条,过不了的写法不进代码。组件按左上导航的五个场景域归类:
            新功能先定场景、再复用该场景已有组件,没有的才新造(新造也必须过铁律)。
            本页即规范正文;工程约束同步收录于 AGENTS.md「UI 铁律」节。
          </p>
          <div className="uk-rules">
            <div className="uk-rule">
              <h4>一 · 全宋</h4>
              <p>
                中国风产品,一切中文 UI(标题/正文/按钮/菜单/表单/Toast)用宋体系;
                数字、代码、路径、键帽用 <code>--font-mono</code>;
                <code>--font-sans</code> 仅允许 12px 以下 meta 小字(宋体小字号笔画糊)。
                正文的「用户可调字体」是文档区预留的 override 接口,不动全局 token。
              </p>
              <p className="uk-do">√ font-family: var(--font-zh-serif)</p>
              <p className="uk-dont">× 页面自造字体变量(--ccx-serif / --home-songti / --qj-* / --cm-*)</p>
            </div>
            <div className="uk-rule">
              <h4>二 · 默认直角</h4>
              <p>
                中文 UI 直角更锋利。border-radius 默认 0;仅三类白名单例外——chip/药丸
                (<code>--r-pill</code>)、头像与圆点(50%)、对话气泡。菜单、弹层、卡片、按钮、
                输入框、Toast 一律直角,浮层靠阴影分层,不靠圆角。
              </p>
              <p className="uk-do">√ 答不出「属于哪个例外」就写 0</p>
              <p className="uk-dont">× --r-sm / --r / --r-lg 尺寸阶梯(废止);× 随手 4/6/8/10px</p>
            </div>
            <div className="uk-rule">
              <h4>三 · 暖纸金唯一真相</h4>
              <p>
                色彩只用 ink-skin 暖化后的 token:奶白纸底、暖棕线、暖墨字、金铜强调;
                对话区是暗墨暖金。基础 tokens.css 的冷绿灰是历史残留,禁止直接引用。
              </p>
              <p className="uk-do">√ var(--ink-1) / var(--mark) / var(--line-2)</p>
              <p className="uk-dont">× 冷灰(#e9eae6 系)/ 臆造紫蓝 / 纯黑纯白</p>
            </div>
            <div className="uk-rule">
              <h4>四 · 反馈分级</h4>
              <p>
                Toast 全站只有一个家族(域四):瞬时(自动退场)与常驻(带动作、手动关)两形态。
                与具体控件强绑定的状态用内联提示;不可逆动作用确认弹层。都不许拿 Toast 顶替。
              </p>
              <p className="uk-do">√ 复制成功=瞬时;导出失败+重试=常驻</p>
              <p className="uk-dont">× 三套并存(wf-toast / ccx-toast / doc-ver-toast → 归一)</p>
            </div>
          </div>
        </Section>

        {/* 1. 颜色 token */}
        <Section idx="01" zh="设计 Token · 颜色(暖纸·金)" en="Color tokens" id="t">
          {COLOR_GROUPS.map((g) => (
            <div className="uk-group" key={g.title}>
              <h3>{g.title}</h3>
              <div className="uk-swatches">
                {g.tokens.map(([name, val, onDark]) => (
                  <div className="uk-swatch" key={name}>
                    <div
                      className="uk-chip"
                      style={{
                        background: onDark ? "#1a1410" : val,
                      }}
                    >
                      {onDark ? (
                        <span style={{ color: val, fontFamily: "var(--font-mono)", fontSize: 11, paddingLeft: 10, lineHeight: "56px" }}>
                          文字 Aa
                        </span>
                      ) : null}
                    </div>
                    <div className="uk-meta">
                      <span className="uk-name">{name}</span>
                      <span className="uk-val">{val}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Section>

        {/* 2. 字体 */}
        <Section idx="02" zh="字体排印" en="Typography" id="type">
          <Group title="字体族" code="--font-*">
            {FONTS.map(([token, label, sample]) => (
              <div className="uk-font-line" key={token}>
                <span className="uk-lbl">
                  {label}
                  <br />
                  {token}
                </span>
                <span className="uk-demo" style={{ fontFamily: `var(${token})` }}>
                  {sample}
                </span>
              </div>
            ))}
          </Group>
          <Group title="收敛映射(清洗目标)" code="8 套散落写法 → 3 个角色 token">
            <table className="uk-map">
              <thead>
                <tr>
                  <th>现状写法</th>
                  <th>归宿</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {FONT_MAP.map(([from, to, note]) => (
                  <tr key={from}>
                    <td>{from}</td>
                    <td>{to}</td>
                    <td>{note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Group>
          <Group title="标题层级 · 正文" code=".wf-doc h1–h6 / p">
            <div className="wf-doc">
              <h1>H1 一级标题 · 起床到出门</h1>
              <h2>H2 二级标题 · 章节</h2>
              <h3>H3 三级标题</h3>
              <h4>H4 四级标题</h4>
              <h5>H5 五级标题</h5>
              <h6>H6 六级标题</h6>
              <p>正文段落:这是一段用于演示行高与字号的中文正文。The quick brown fox jumps over the lazy dog.</p>
            </div>
          </Group>
        </Section>

        {/* 3. 直角 / 阴影 —— 圆角从「尺寸阶梯」改为「白名单决策」 */}
        <Section idx="03" zh="直角 · 阴影" en="Radius (allowlist) & shadow" id="shape">
          <Group title="直角决策(铁律二)" code="默认 0 · 白名单:--r-pill / 50% / 气泡角">
            <p className="uk-cap uk-lead">
              写 border-radius 前三问:是 chip/药丸?是头像/圆点?是对话气泡?三问皆否 → 0。
              浮层与底层的区分靠阴影,不靠圆角。
            </p>
            <div className="uk-spec-tiles">
              {RADIUS_ALLOW.map(([name, val, use]) => (
                <div
                  key={name}
                  className="uk-tile uk-tile--allow"
                  style={{
                    borderRadius: val,
                    width: val === "50%" ? 64 : undefined,
                    minWidth: val === "50%" ? 0 : 150,
                  }}
                >
                  {name} {val !== "50%" ? val : ""}
                  <br />
                  {use}
                </div>
              ))}
            </div>
          </Group>
          <Group title="废止(清洗对象)" code="--r-sm / --r / --r-lg 尺寸阶梯 + 全库 300+ 处硬编码圆角">
            <div className="uk-spec-tiles">
              {RADIUS_DEPRECATED.map(([token, val]) => (
                <div key={token} className="uk-tile uk-tile--dep" style={{ borderRadius: val }}>
                  {token.replace("--", "")} {val}
                  <br />
                  改直角或并入白名单
                </div>
              ))}
            </div>
          </Group>
          <Group title="阴影" code="--shadow-1 / 2 / 3">
            <div className="uk-spec-tiles">
              {SHADOWS.map(([token, lvl]) => (
                <div
                  key={token}
                  className="uk-tile"
                  style={{ boxShadow: `var(${token})`, border: "none", background: "var(--bg-canvas)" }}
                >
                  {token.replace("--", "")}
                  <br />
                  {lvl}
                </div>
              ))}
            </div>
          </Group>
        </Section>

        {/* 4. 按钮 */}
        <Section idx="04" zh="按钮" en="Button" id="btn">
          <Group title="变体" code=".wf-btn / .primary / .ghost">
            <div className="uk-row">
              <Cell cap=".wf-btn">
                <button className="wf-btn">默认</button>
              </Cell>
              <Cell cap=".wf-btn.primary">
                <button className="wf-btn primary">主操作</button>
              </Cell>
              <Cell cap=".wf-btn.ghost">
                <button className="wf-btn ghost">幽灵</button>
              </Cell>
              <Cell cap=":disabled">
                <button className="wf-btn" disabled>
                  禁用
                </button>
              </Cell>
            </div>
          </Group>
          <Group title="尺寸 / 形态" code=".small / .lg / .icon / .square">
            <div className="uk-row">
              <Cell cap=".small">
                <button className="wf-btn small">小</button>
              </Cell>
              <Cell cap="默认">
                <button className="wf-btn">中</button>
              </Cell>
              <Cell cap=".lg">
                <button className="wf-btn lg">大</button>
              </Cell>
              <Cell cap=".icon">
                <button className="wf-btn icon" aria-label="图标">
                  ⛶
                </button>
              </Cell>
              <Cell cap=".square">
                <button className="wf-btn square">直角</button>
              </Cell>
              <Cell cap=".primary.lg">
                <button className="wf-btn primary lg">提交</button>
              </Cell>
            </div>
          </Group>
          <div className="uk-group">
            <h3>
              落在暗墨 chrome(对话区深色面)
              <code>.uk-dark</code>
            </h3>
            <div className="uk-stage uk-dark">
              <div className="uk-row">
                <button className="wf-btn">默认</button>
                <button className="wf-btn primary">主操作</button>
                <button className="wf-btn ghost">幽灵</button>
                <span className="wf-chip mono">引用 · code.ts</span>
              </div>
            </div>
          </div>
        </Section>

        {/* 5. 芯片 —— 只陈列有生产渲染点的形态;库存变体与已删死件一律文字墓碑 */}
        <Section idx="05" zh="芯片" en="Chip" id="chip">
          <Group title="芯片 chip(仅现役形态)" code=".wf-chip(AskUserOverlay)/ .wf-chip.mono(ChatMessageList 引用)">
            <div className="uk-row">
              <Cell cap=".wf-chip · AskUserOverlay.tsx:361">
                <span className="wf-chip">问卷选项标签</span>
              </Cell>
              <Cell cap=".wf-chip.mono · ChatMessageList.tsx:999">
                <span className="wf-chip mono">引用 · src-开幕式</span>
              </Cell>
            </div>
          </Group>
          <p className="uk-cap uk-lead">
            墓碑:旧键帽、注记、标签库存样式已随 ui-kit 死件物理删除,不再活渲染;
            Chip 组件的 <code>.solid/.dashed/.dot/.x</code> 变体为 ui-kit 库存(Chip.tsx 无生产消费者),同样不陈列。
          </p>
        </Section>

        {/* 6. 身份头像 —— 死件已删,只留一行墓碑 */}
        <Section idx="06" zh="头像 · 身份(已删除)" en="Profile — removed" id="profile">
          <p className="uk-cap uk-lead">
            墓碑:旧身份头像库存样式正式链路零使用,已物理删除。将来做多用户/协作再按铁律重设计(圆形属白名单)。
          </p>
        </Section>

        {/* 7. 卡片 / 区域 —— 只陈列有生产渲染点的变体 */}
        <Section idx="07" zh="卡片 · 区域" en="Card / Region" id="card">
          <Group title="区域(仅现役形态)" code=".wf-region(WorkspacePage 审核态 patch 条带)">
            <div className="uk-row">
              <div className="wf-region" style={{ width: 320, maxWidth: "100%" }}>
                <span className="font-mono">本轮 3 处块级改动暂不可视,请提交或放弃本轮修改。</span>
              </div>
            </div>
          </Group>
          <p className="uk-cap uk-lead">
            墓碑·已物理删除:<code>.wf-region.subtle</code> / <code>.wf-region-label</code> / <code>.ws-outline</code> 曾唯一用于文档大纲
            <code>DocOutline.tsx</code>;该组件与皮肤禁用规则已于 2026-07 随大纲下线一并物理删除,代码中不复存在,不再活渲染,故不陈列。
            墓碑·停摆:<code>.wf-region</code> 的历史版本横幅变体(HistoryViewingBanner · WorkspacePage.tsx:4779)
            为 hash-only 无 UI 入口(<code>HISTORY_ENTRY_ENABLED=false</code> WorkspacePage.tsx:176;viewingVersion
            仅 URL hash workspacePageView.ts:122),已停摆,不陈列。
            墓碑:<code>.thick/.dashed/.ghost</code> 变体为 ui-kit 库存、零生产渲染,不陈列。
          </p>
        </Section>

        {/* ══════════════ 域一 · 首页 ══════════════ */}

        <Section idx="08" zh="首页 · 浮动入口" en="Home float controls" id="home-float">
          <p className="uk-cap uk-lead">
            对应真机:首页长卷上的浮动入口——右上设置齿轮、左下新建浮钮、右下进度 dock 与搜索;画布/卷轴/瀑布流本体是一次性整页构图,不抽 Kit。
          </p>
          <Group title="浮动入口组合" code=".qj-settings-btn / .qj-new-fab / .qj-dock / .qj-new-card">
            <div
              className="qj-root uk-home-stage"
              data-anim="rise"
              style={
                {
                  "--qj-nc-noise":
                    "linear-gradient(135deg, rgba(120,90,40,.08), transparent 42%), repeating-linear-gradient(90deg, rgba(80,60,32,.05) 0 1px, transparent 1px 7px)",
                  // 真机纹理为运行时 canvas 噪点(墨色 rgb 30-64/25-53/16-36,QingjianScroll.tsx:1033);样张用同色域纯墨渐变示意,不带朱红
                  "--qj-nc-inktex": "linear-gradient(180deg, rgb(48,42,30), rgb(64,53,36) 55%, rgb(38,33,24))",
                } as CSSProperties
              }
            >
              <div className="qj-topctrl">
                <div className="qj-settings-wrap">
                  <button className="qj-settings-btn" type="button" aria-label="设置">
                    ⚙
                  </button>
                </div>
                <div className="qj-settings-wrap">
                  <button className="qj-settings-btn qj-on" type="button" aria-label="设置已打开">
                    ⚙
                  </button>
                </div>
              </div>
              <div className="qj-card-slot qj-in uk-home-new-slot">
                <div className="qj-sway">
                  <div className="cm-card qj-new-card" role="button" tabIndex={0}>
                    <span className="qj-nc-tex" aria-hidden="true" />
                    <span className="qj-nc-shade" aria-hidden="true" />
                    <span className="qj-nc-frame" aria-hidden="true" />
                    <span className="qj-nc-corner qj-tl" aria-hidden="true" />
                    <span className="qj-nc-corner qj-br" aria-hidden="true" />
                    <span className="qj-nc-title">新建文档</span>
                  </div>
                </div>
              </div>
              <button className="qj-new-fab qj-show" type="button" aria-label="新建文档">
                +
              </button>
              <div className="qj-dock qj-show">
                <div className="qj-dock-preview qj-show" style={{ left: "42%" }}>
                  <div className="qj-dock-preview-card">
                    <div className="qj-dock-preview-title">春日手记</div>
                    <div className="qj-dock-preview-body">一页纸面预览,用于 hover 进度条时快速确认当前文章。</div>
                  </div>
                  <div className="qj-dock-preview-meta">第 5 / 12 篇</div>
                </div>
                <div className="qj-dock-bar">
                  <div className="qj-dock-prog" role="slider" aria-valuemin={0} aria-valuemax={100} aria-valuenow={58}>
                    <div className="qj-dp-track">
                      <div className="qj-dp-fill" style={{ transform: "scaleX(.58)" }} />
                      <div className="qj-dp-cursor" style={{ left: "58%" }} />
                    </div>
                    <div className="qj-dp-scale">
                      <span>卷首</span>
                      <span>卷尾</span>
                    </div>
                  </div>
                  <button className="qj-dock-search-btn qj-on" type="button" aria-label="搜索文章">
                    ⌕
                  </button>
                  <div className="qj-dock-search-wrap qj-open">
                    <input className="qj-dock-search-input" defaultValue="春日" aria-label="搜索关键词" readOnly />
                    <span className="qj-dock-search-count">3</span>
                  </div>
                </div>
              </div>
            </div>
            <p className="uk-cap uk-lead">
              证据:设置按钮 <code>QingjianScroll.tsx:2337 / qingjian.css:1423</code>;新建浮钮
              <code>QingjianScroll.tsx:2550 / qingjian.css:1904</code>;新建卡
              <code>QingjianScroll.tsx:2432,2565 / qingjian.css:1222,1339</code>;dock 与搜索
              <code>QingjianScroll.tsx:2480,2518 / qingjian.css:1688,1779</code>;预览卡
              <code>QingjianScroll.tsx:2490 / qingjian.css:1835</code>。<code>qj-nc-tex</code>
              纹理为运行时程序化生成,样张示意。
            </p>
          </Group>
        </Section>

        <Section idx="09" zh="首页 · 设置弹框控件" en="Home settings controls" id="home-settings">
          <p className="uk-cap uk-lead">
            对应真机:首页右上设置弹框(泼墨深底)——弹框外壳与泼墨背景是一次性构图(qj-sheet 外壳已在档案层),这里抽的是弹框上的<b>内容控件</b>:tab、表单、按钮、开关、状态卡、快捷键表。
          </p>
          <Group title="设置内容控件" code=".qj-sheet token scope · qj-sheet-tab / sm-* / md-* / sk-* / sc-*">
            <div className="qj-sheet uk-sheet-stage">
              <button className="qj-sheet-close" type="button" aria-label="关闭">
                ×
              </button>
              <div className="qj-sheet-nav uk-sheet-nav-demo">
                <div className="qj-sheet-title">设置</div>
                <div className="qj-sheet-tabs">
                  <button className="qj-sheet-tab qj-active" type="button">
                    模型
                  </button>
                  <button className="qj-sheet-tab" type="button">
                    技能
                  </button>
                  <button className="qj-sheet-tab" type="button">
                    快捷键
                  </button>
                </div>
              </div>
              <div className="qj-sheet-body uk-sheet-body-demo">
                <div className="settings-model">
                  <div className="sm-config uk-sheet-demo-block">
                    <div className="sm-setup-tabs">
                      <button className="sm-setup-tab sm-active sm-official" type="button">
                        <span>接入 DeepSeek 官方 API</span>
                        <small>官方余额与用量看板</small>
                      </button>
                      <button className="sm-setup-tab sm-other" type="button">
                        <span>接入其他云厂商</span>
                        <small>自定义 Base URL</small>
                      </button>
                    </div>
                    <div className="sm-field">
                      <label className="sm-field-label">Base URL</label>
                      <input className="sm-field-input" defaultValue="https://api.deepseek.com/v1" readOnly />
                    </div>
                    <div className="sm-field">
                      <label className="sm-field-label">模型名</label>
                      <input className="sm-field-input sm-field-input--invalid" defaultValue="" placeholder="deepseek-chat" readOnly />
                      <p className="sm-field-err">模型名不可为空。</p>
                    </div>
                    <div className="sm-keyrow">
                      <span className="sm-secret-wrap">
                        <input className="sm-keyinput sm-secret" defaultValue="sk-live-demo-key" aria-label="API Key" readOnly />
                        <button className="sm-secret-toggle" type="button" aria-label="显示密钥">
                          <EyeGlyph />
                        </button>
                      </span>
                      <button className="sm-btn" type="button">
                        测试
                      </button>
                      <button className="sm-btn" type="button" disabled>
                        保存
                      </button>
                    </div>
                  </div>
                  <div className="md-card md-account uk-sheet-demo-block">
                    <div className="md-status-row">
                      <span className="md-dot md-dot--ok" />
                      <span className="md-status-text">连通正常</span>
                      <button className="md-recheck" type="button">
                        重新检测
                      </button>
                    </div>
                    <div className="md-status-row">
                      <span className="md-dot md-dot--bad" />
                      <span className="md-status-text">密钥失效</span>
                    </div>
                    <div className="md-status-row">
                      <span className="md-dot md-dot--warn" />
                      <span className="md-status-text">余额预警</span>
                    </div>
                    <div className="md-keyops">
                      <button className="md-mini-btn" type="button">
                        修改配置
                      </button>
                      <button className="md-mini-btn" type="button">
                        清除
                      </button>
                    </div>
                    <div className="md-views md-views--right">
                      <button className="md-view-btn md-active" type="button">
                        按天
                      </button>
                      <button className="md-view-btn" type="button">
                        按文档
                      </button>
                    </div>
                  </div>
                  <div className="md-metrics md-metrics--3 uk-sheet-demo-block">
                    <div className="md-metric">
                      <div className="md-metric-label">近 7 天消耗</div>
                      <div className="md-metric-value md-value-accent">¥12.48</div>
                      <div className="md-metric-sub">deepseek-v4-flash</div>
                    </div>
                    <div className="md-metric">
                      <div className="md-metric-label">文档</div>
                      <div className="md-metric-value">18</div>
                      <div className="md-metric-sub">已生成</div>
                    </div>
                    <div className="md-metric">
                      <div className="md-metric-label">平均每篇</div>
                      <div className="md-metric-value">¥0.69</div>
                      <div className="md-metric-sub">含搜索工具</div>
                    </div>
                  </div>
                  <div className="settings-search uk-sheet-demo-block">
                    <section className="ss-card">
                      <span className="ss-badge ss-ok">搜索已配置</span>
                    </section>
                  </div>
                </div>
                <div className="settings-skills uk-sheet-demo-block">
                  <div className="sk-subhead">
                    <button className="sk-back" type="button">
                      <span className="sk-back-arrow">‹</span>
                      返回技能
                    </button>
                    <span className="sk-subtitle">联网搜索</span>
                  </div>
                  <div className="sk-grid">
                    <div className="sk-card">
                      <div className="sk-card-head">
                        <span className="sk-card-icon">搜</span>
                        <span className="sk-card-title">联网搜索</span>
                        <button className="sk-toggle sk-on" type="button">
                          <span className="sk-toggle-dot" />
                          已启用
                        </button>
                      </div>
                      <p className="sk-card-desc">调用搜索源补齐事实、日期与出处。</p>
                      <button className="sk-search-toggle" type="button">
                        配置搜索引擎 <span className="sk-card-arrow">›</span>
                      </button>
                      <div className="sk-card-foot">
                        <span className="sk-card-tag">可配置</span>
                      </div>
                    </div>
                    <div className="sk-card sk-off">
                      <div className="sk-card-head">
                        <span className="sk-card-icon">图</span>
                        <span className="sk-card-title">图像识别</span>
                        <button className="sk-toggle" type="button">
                          <span className="sk-toggle-dot" />
                          已停用
                        </button>
                      </div>
                      <p className="sk-card-desc">读取图片中的文字、结构和视觉线索。</p>
                      <div className="sk-card-foot">
                        <span className="sk-card-tag">视觉</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="settings-shortcuts uk-sheet-demo-block">
                  <div className="sc-group">
                    <h4 className="sc-group-title">常用快捷键</h4>
                    <ul className="sc-list">
                      <li className="sc-item">
                        <span className="sc-label">打开设置</span>
                        <span className="sc-keys">
                          <kbd className="sc-kbd">⌘</kbd>
                          <kbd className="sc-kbd">,</kbd>
                        </span>
                      </li>
                      <li className="sc-item">
                        <span className="sc-label">搜索文档</span>
                        <span className="sc-keys">
                          <kbd className="sc-kbd">⌘</kbd>
                          <kbd className="sc-kbd">K</kbd>
                        </span>
                      </li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
            <p className="uk-cap uk-lead">
              证据:tab/关闭 <code>HomeSettingsSheet.tsx:142,159 / settings.css:129,155</code>;配置 tab
              <code>ModelSettingsPanel.tsx:487 / modelDashboard.css:696</code>;输入/密钥/按钮
              <code>SecretInput.tsx:12 / settings.css:325,392 / modelDashboard.css:776,814</code>;模型状态/指标/视图按钮
              <code>ModelSettingsPanel.tsx:683,707,881 / modelDashboard.css:75,143,422</code>;技能卡/返回
              <code>SkillsPanel.tsx:253,289,328 / settings.css:231,270,274</code>;搜索徽标
              <code>SearchPanel.tsx:220 / settings.css:459</code>;快捷键 <code>ShortcutsPanel.tsx:9 / settings.css:284</code>。
              注记:模型用量图表(#9)与技能导入卡/右键菜单(#13)只记录为文字;视觉配置卡(#15)与搜索配置卡(#14)同构,不重复陈列。
            </p>
            <p className="uk-cap uk-lead">
              墓碑·停摆:外观分支控件 <code>qj-swatch/qj-font-select/qj-ap-mode/qj-sp-row/qj-bt-track/qj-bt-knob/qj-sp-action</code>
              与书阁入口——『外观』tab 已从 TABS 摘除(HomeSettingsSheet.tsx:41 注释『「外观」整组已隐藏』),整分支无 UI 入口,不陈列。书阁弹层(qj-shelf-*)与书源卡(home-book-*)随之不可达。泼墨调试浮层(qj-ink-debug-*,Ctrl+Shift+H)为开发调试件,不属用户态 Kit。
            </p>
          </Group>
        </Section>

        <Section idx="10" zh="首页 · 菜单与确认" en="Home menus & confirmation" id="home-menus">
          <p className="uk-cap uk-lead">
            对应真机:首页右键文章卡的上下文菜单、删除二次确认弹框、列表拉取失败的顶部重试条。
          </p>
          <div id="view-home" className="uk-home-menu-stage">
            <Group title="右键菜单" code=".home-card-menu / .home-card-menu-item / .is-danger">
              <div className="home-card-menu">
                <button className="home-card-menu-item" type="button">
                  打开文章
                </button>
                <button className="home-card-menu-item is-danger" type="button">
                  删除文章
                </button>
              </div>
              <p className="uk-cap uk-lead">
                证据:<code>HomePage.tsx:308,315,324 / home.css:70</code>。
              </p>
            </Group>
            <Group title="删除确认控件" code=".home-delete-confirm-actions / .ws-folder-check">
              <div className="uk-home-confirm-card">
                <label className="ws-folder-check">
                  <input type="checkbox" defaultChecked />
                  <span>24小时内不再提醒</span>
                </label>
                <div className="home-delete-confirm-actions">
                  <button className="ws-folder-modal-danger" type="button">
                    删除
                  </button>
                  <button className="ws-folder-modal-secondary" type="button">
                    取消
                  </button>
                </div>
              </div>
              <p className="uk-cap uk-lead">
                证据:<code>HomePage.tsx:362 / home.css:215</code>;整弹框外壳不重复,这里只陈列首页特有按钮排与 checkbox 行。
              </p>
            </Group>
            <Group title="列表拉取失败重试条" code=".home-fetch-error">
              <div className="home-fetch-error" role="alert">
                <span>列表拉取失败</span>
                <button type="button">重试</button>
              </div>
              <p className="uk-cap uk-lead">
                证据:<code>HomePage.tsx:289 / home.css:393</code>。
              </p>
            </Group>
          </div>
        </Section>

        {/* ══════════════ 域二 · 文档页 — 对话流(左栏) ══════════════ */}

        {/* 11. 消息气泡 —— 不做独立手搭演示:任何裸渲都不是现实 */}
        <Section idx="11" zh="消息气泡(指路)" en="Message — see §12/§15" id="msg">
          <p className="uk-cap uk-lead">
            对应真机:文档页左栏对话流——用户气泡、AI 正文、工具卡、审核回流卡都在这里。
          </p>
          <p className="uk-cap uk-lead">
            本节不做独立演示——生产用户气泡<b>永远</b>由 <code>InkBubble</code> 泼墨层包裹
            <code>.wf-msg.user</code>(ChatMessageList.tsx:255),裸渲 .wf-msg.user 或画廊装饰类
            .u-user 均不是现实。真实渲染见 <b>15 节</b>(经 ChatMessageList 真分发的用户气泡)与
            <b>12 节</b>(AI 正文 / 工具行 / 工具卡等全部现役对话组件)。
          </p>
        </Section>

        {/* 12. 现役对话组件(真实生产组件 · 暗墨暖金皮肤) */}
        <Section idx="12" zh="现役对话组件" en="Live chat components" id="chat">
          <p className="uk-cap" style={{ display: "block", marginBottom: 12 }}>
            下方为对话区真实在用的统一组件(chatUnified 的 .u-* 生产单一真源)。皮肤来自
            <code>#view-workspace .ws-left</code> 作用域(暗墨底 + 暖金组件),故整组包在它自己的
            <code>#view-workspace</code> 容器里;不影响本页其它节。
          </p>
          {/* 关键:#view-workspace + .ws-left.uk-sp-scope 提供暗墨暖金皮肤令牌,骨架规则收在 uikit.css */}
          <div id="view-workspace" className="uk-sp-view" style={{ height: "auto", overflow: "visible" }}>
            <div className="ws-left uk-sp-scope">
              <div className="uk-sp-wrap u-scope" style={{ padding: "8px 0 0" }}>
                <section className="uk-sp-section">
                  <h2 className="uk-sp-h2">
                    通用工具栏 · 五态
                    <span className="uk-sp-hint">done / running / pending / failed / 仅标题</span>
                  </h2>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">done(出参概要 + 详情折叠)</div>
                    <div className="uk-sp-rowbody u-scope">
                      <UToolBar spec={tool("mastra_workspace_read_file", ST.done, generic({ path: "/work/draft.md" }), gres({ bytes: 4096 }))} />
                    </div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">running(三个点 + 入参)</div>
                    <div className="uk-sp-rowbody u-scope">
                      <UToolBar spec={tool("parseFile", ST.running, generic({ filePath: "/uploads/赛事手册.pdf" }))} />
                    </div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">pending(等待 = 三个点)</div>
                    <div className="uk-sp-rowbody u-scope">
                      <UToolBar spec={tool("editDraft", ST.pending, generic({ blockId: "b-12" }))} />
                    </div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">failed(仅「未完成」,不报红)</div>
                    <div className="uk-sp-rowbody u-scope">
                      <UToolBar spec={tool("fetchArticle", ST.failed("超时"), generic({ url: "https://x.com" }))} />
                    </div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">仅标题(无参数 / 无折叠)</div>
                    <div className="uk-sp-rowbody u-scope">
                      <UToolBar spec={tool("summarizeMaterial", ST.done, generic({}))} />
                    </div>
                  </div>
                </section>

                <section className="uk-sp-section">
                  <h2 className="uk-sp-h2">工具卡(统一外壳)</h2>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">联网搜索 UResearch</div>
                    <div className="uk-sp-rowbody u-scope"><UResearch body={researchDone} /></div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">生成配图 USvg</div>
                    <div className="uk-sp-rowbody u-scope"><USvg body={svgDone} status="done" /></div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">生成草稿 UDraft</div>
                    <div className="uk-sp-rowbody u-scope"><UDraft body={draftDone} /></div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">运行代码 UCommand</div>
                    <div className="uk-sp-rowbody u-scope"><UCommand body={cmdDone} /></div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">确认方向 UAskUser</div>
                    <div className="uk-sp-rowbody u-scope"><UAskUser questions={askQ} answers={askA} /></div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">扫码 UQr</div>
                    <div className="uk-sp-rowbody u-scope"><UQr data={qrData} /></div>
                  </div>
                </section>

                <section className="uk-sp-section">
                  <h2 className="uk-sp-h2">
                    其它元素
                    <span className="uk-sp-hint">来源卡走生产 BrowserViewPart · 引用走生产 wf-chip.mono</span>
                  </h2>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">来源卡(带图)</div>
                    <div className="uk-sp-rowbody u-scope">
                      <BrowserViewPart data={sourceImageWithThumb} />
                    </div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">来源卡(无图)</div>
                    <div className="uk-sp-rowbody u-scope">
                      <BrowserViewPart data={sourceImageNoThumb} />
                    </div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">引用块</div>
                    <div className="uk-sp-rowbody">
                      <Live parts={[{ kind: "citation", data: { sourceRef: { id: "src-开幕式", domain: { kind: "source" } }, anchor: "2" } }]} />
                    </div>
                  </div>
                </section>

                <section className="uk-sp-section">
                  <h2 className="uk-sp-h2">
                    轮级折叠 UTurnFold
                    <span className="uk-sp-hint">一轮过程折成「过程 · N 步」,点开看明细</span>
                  </h2>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">折叠态(默认)</div>
                    <div className="uk-sp-rowbody u-scope">
                      {/* 上下文用生产 ChatMessageList 真分发渲染(用户气泡=InkBubble 包 wf-msg.user,
                          AI 正文=wf-msg.agent),不再手搭画廊装饰类 u-user/u-agent。 */}
                      <div className="uk-sp-turn">
                        <Live role="user" parts={[{ kind: "text", data: { body: "帮我写一篇杭州亚运会的观察报道，800 字左右。" } }]} />
                        <UTurnFold parts={processParts} />
                        <Live parts={[{ kind: "text", data: { body: "**初稿已完成**：约 800 字、面向大众、含一张示意配图，授权后即可发布。需要我调整语气吗？" } }]} />
                      </div>
                    </div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">展开态</div>
                    <div className="uk-sp-rowbody u-scope">
                      <div className="uk-sp-turn">
                        <UTurnFold parts={processParts} defaultOpen />
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>
        </Section>

        {/* 13. 审核态回流 · 修订(真实生产组件 · 暗墨暖金皮肤) */}
        <Section idx="13" zh="审核态回流 · 修订" en="Review outcome / patch" id="review">
          <p className="uk-cap" style={{ display: "block", marginBottom: 12 }}>
            现役审核回流:用户在右侧审阅后点「提交(局部采纳)」或「放弃本轮修改」→ 以用户名义把
            <code>reviewOutcome</code> 回流进对话流,渲染成 <code>ReviewOutcomeCard</code> 缩略卡(可展开看逐处
            before/after);左侧对话流内联一条 <code>patchSummary</code> 工具条。全部走生产组件与真实分发路径。
          </p>
          <div id="view-workspace" className="uk-sp-view" style={{ height: "auto", overflow: "visible" }}>
            <div className="ws-left uk-sp-scope">
              <div className="uk-sp-wrap u-scope" style={{ padding: "8px 0 0" }}>
                <section className="uk-sp-section">
                  <h2 className="uk-sp-h2">
                    审核回流卡 ReviewOutcomeCard
                    <span className="uk-sp-hint">采纳/拒绝混合 · 放弃本轮全部 · 全部采纳(点击展开看逐处)</span>
                  </h2>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">采纳 2 · 拒绝 1</div>
                    <div className="uk-sp-rowbody u-scope"><ReviewOutcomeCard data={reviewMixed} /></div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">放弃本轮全部</div>
                    <div className="uk-sp-rowbody u-scope"><ReviewOutcomeCard data={reviewAllRejected} /></div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">全部采纳</div>
                    <div className="uk-sp-rowbody u-scope"><ReviewOutcomeCard data={reviewAllAccepted} /></div>
                  </div>
                </section>
                <section className="uk-sp-section">
                  <h2 className="uk-sp-h2">
                    修订工具条 patchSummary
                    <span className="uk-sp-hint">已修改 N 处 / 待确认 / 应用中 / 整篇改写 / 已放弃</span>
                  </h2>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">已修改 N 处(历史)</div>
                    <div className="uk-sp-rowbody">
                      <Live parts={[{ kind: "patchSummary", data: { count: 3, hunkIds: ["hh"] } }]} />
                    </div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">待确认(当前审批轮)</div>
                    <div className="uk-sp-rowbody">
                      <Live parts={[{ kind: "patchSummary", data: { count: 3, hunkIds: ["h1"] } }]} liveHunkKey="h1" livePatchCount={3} />
                    </div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">正在应用修改…</div>
                    <div className="uk-sp-rowbody">
                      <Live parts={[{ kind: "patchSummary", data: { count: 3, hunkIds: ["h2"] } }]} liveHunkKey="h2" livePatchCount={3} patchRevealing />
                    </div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">整篇改写(大改)</div>
                    <div className="uk-sp-rowbody">
                      <Live parts={[{ kind: "patchSummary", data: { count: 9, hunkIds: ["hw"] } }]} liveHunkKey="hw" livePatchCount={9} wholeDocReview />
                    </div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">本轮候选已放弃</div>
                    <div className="uk-sp-rowbody">
                      <Live parts={[abandonedPatchPart()]} />
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>
        </Section>

        {/* 14. AskUser 开场问卷 BigPlanPanel(census 最大缺口 · 真组件) */}
        <Section idx="14" zh="开场问卷 BigPlanPanel" en="AskUser questionnaire" id="bigplan">
          <p className="uk-cap uk-lead">
            AskUser 的 <b>fullpage 形态</b>:右栏渲染生产 <code>BigPlanPanel</code>,提交 AskUserAnswers。
            覆盖四种题型——滑块(<code>au-slider / au-slider-input</code>)、单选、多选(带说明 <code>bp-opt.has-desc</code>)、
            文字(<code>bp-ta</code>);底部悬浮操作条复用 <code>ws-float-bar</code>(与审批条同款)。
            这是 census 最大的一处缺口,此处以真组件 + mock spec 补全。
          </p>
          <div id="view-workspace" className="uk-sp-view" style={{ height: "auto", overflow: "visible" }}>
            <div className="ws-left uk-sp-scope">
              <div style={{ maxWidth: 560, background: "var(--ws-right-bg, transparent)" }}>
                <BigPlanPanel
                  spec={bigPlanSpec}
                  isStreaming={false}
                  onSubmit={() => {}}
                  onAbort={() => {}}
                  sessionId={null}
                  stream={null}
                  onToast={() => {}}
                />
              </div>
            </div>
          </div>
        </Section>

        {/* 15. 泼墨气泡 —— 经生产 ChatMessageList 真分发:InkBubble 包 wf-msg.user */}
        <Section idx="15" zh="泼墨气泡(用户气泡真实路径)" en="Ink bubble via ChatMessageList" id="ink">
          <p className="uk-cap uk-lead">
            生产用户气泡的唯一形态:<code>ChatMessageList</code> 对 user 角色消息渲染
            <code>InkBubble</code>(three.js 着色器泼墨,左→右扫墨、墨干显字)包裹
            <code>.wf-msg.user</code>(ChatMessageList.tsx:255)。下方即真分发路径渲染,非手搭。
          </p>
          <div id="view-workspace" className="uk-sp-view" style={{ height: "auto", overflow: "visible" }}>
            <div className="ws-left uk-sp-scope">
              <div className="uk-sp-wrap u-scope" style={{ padding: "14px", maxWidth: 520 }}>
                <Live role="user" parts={[{ kind: "text", data: { body: "帮我把这段改得更有画面感。" } }]} />
              </div>
            </div>
          </div>
        </Section>

        {/* ══════════════ 域二 · 文档页 — 编辑器(右栏) ══════════════ */}

        {/* 16. 文档元素 */}
        <Section idx="16" zh="文档元素 · 表格 · 修订" en="Doc / Table / Diff" id="doc">
          <p className="uk-cap uk-lead">
            对应真机:文档页右栏编辑器——文档纸、图表块、审核态修订标记与各浮动工具条。
          </p>
          <Group title="表格" code=".wf-doc table">
            <div className="wf-doc">
              <table>
                <thead>
                  <tr>
                    <th>季度</th>
                    <th>收入</th>
                    <th>利润</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Q1</td>
                    <td>1000</td>
                    <td>400</td>
                  </tr>
                  <tr>
                    <td>Q2</td>
                    <td>1200</td>
                    <td>500</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Group>
          <Group
            title="修订标记(现役真实表示法 · 条件出现)"
            code=".wf-patch-ins(-wrap) / .wf-patch-del-marker + .patch-del-cursor(DocumentSnapshotView.tsx:3923)"
          >
            <p className="uk-cap uk-lead">
              真实行为:<b>新增</b>=正文内高亮嵌入(census 现役);<b>删除</b>=原位只留「竖线+圆点」游标、
              不显示被删原文,hover 弹浮层看内容(条件出现,census 采样未命中,生产渲染点
              DocumentSnapshotView.tsx:3923);浮层一次只出一种类型(纯删或纯增),
              不存在"删除线与新增同排"的表示法。
            </p>
            <div id="view-workspace" style={{ position: "relative", background: "transparent", minHeight: 0 }}>
              <div className="wf-doc" style={{ fontSize: 14 }}>
                <p>
                  这是一段含 <span className="wf-patch-ins">新增内容</span> 的修订;这里原有一处删除
                  <span className="wf-patch-del-marker">
                    <span className="patch-del-cursor" />
                  </span>
                  只留竖线+圆点游标,hover 出浮层。
                </p>
              </div>
            </div>
          </Group>
        </Section>

        {/* 17. 选中 / 块工具条 DocToolbar(手搭真实类·组件依赖实时选区无法脱上下文实例化) */}
        <Section idx="17" zh="选中 / 块工具条 DocToolbar" en="Selection & block toolbar" id="seltoolbar">
          <p className="uk-cap uk-lead">
            对应真机:文档中选中文字浮出的格式工具条(<code>doc-toolbar</code> 深墨浮条,位置随选区自动翻转
            <code>is-below</code>),以及点选图片/图表/公式等原子块时的紧凑「让 AI 修改」条
            (<code>is-block</code> + <code>dt-block-ai</code>)。组件依赖实时 TipTap 选区、无法脱上下文实例化,
            故手搭真实类名最小 DOM;真机为 <code>position: fixed</code> portal,本页 override 成静态陈列。
          </p>
          <Group title="文本选中工具条(标题下拉展开态)" code=".doc-toolbar.on / .dt-group.dt-dropdown.open / .dt-menu / .dt-mi / .dt-mi-k">
            <div id="view-workspace" className="uk-portal uk-doctoolbar-demo" style={{ height: 280 }}>
              <div className="doc-toolbar on" role="toolbar" aria-label="文档格式工具栏">
                <div className="dt-group dt-dropdown open">
                  <button className="dt-btn active" type="button">
                    <span className="dt-lbl">T</span>
                    <span className="dt-caret">▾</span>
                  </button>
                  <div className="dt-menu" role="menu">
                    <button className="dt-mi" role="menuitem" type="button"><span className="dt-mi-k">H1</span>大标题</button>
                    <button className="dt-mi" role="menuitem" type="button"><span className="dt-mi-k">H2</span>二级标题</button>
                    <button className="dt-mi disabled" role="menuitem" type="button" disabled><span className="dt-mi-k">¶</span>正文</button>
                    <button className="dt-mi" role="menuitem" type="button"><span className="dt-mi-k">•</span>无序列表</button>
                    <button className="dt-mi" role="menuitem" type="button"><span className="dt-mi-k">☑</span>待办清单</button>
                  </div>
                </div>
                <span className="dt-divider" />
                <button className="dt-btn" type="button"><span className="dt-lbl">≡</span><span className="dt-caret">▾</span></button>
                <span className="dt-divider" />
                <button className="dt-btn" type="button"><b>B</b></button>
                <button className="dt-btn active" type="button"><i>I</i></button>
                <button className="dt-btn" type="button"><u>U</u></button>
                <button className="dt-btn" type="button"><s>S</s></button>
                <span className="dt-divider" />
                <button className="dt-btn" type="button" aria-label="行内代码">
                  <span className="dt-code-icon" aria-hidden="true">
                    <svg className="dt-svg" viewBox="0 0 16 16">
                      <path d="M6 4 2.5 8 6 12M10 4l3.5 4L10 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </button>
                <span className="dt-divider" />
                <button className="dt-btn dt-ai" type="button"><span className="dt-ai-ico">✨</span><span>AI 修改</span></button>
              </div>
            </div>
            <p className="uk-cap uk-lead">
              证据:触发/定位 <code>DocToolbar.tsx:396</code>;渲染 <code>DocToolbar.tsx:891</code>;
              菜单/按钮 <code>DocToolbar.tsx:918/1166/1245</code>;CSS <code>workspace.css:1234</code>。
              颜色/高亮二级菜单(<code>dt-menu-colors</code> / <code>dt-swatch</code>)与插入菜单图标
              (<code>dt-menu-icon</code>)同族,不重复陈列。
            </p>
          </Group>
          <Group title="原子块紧凑条(选中图片/图表/公式)" code=".doc-toolbar.on.is-block / .dt-btn.dt-ai.dt-block-ai">
            <div id="view-workspace" className="uk-portal uk-doctoolbar-demo" style={{ height: 88 }}>
              <div className="doc-toolbar on is-block" role="toolbar" aria-label="块操作工具栏">
                <button className="dt-btn dt-ai dt-block-ai" type="button">
                  <span className="dt-ai-ico">✨</span>
                  <span>让 AI 修改这个图表</span>
                </button>
              </div>
            </div>
          </Group>
        </Section>

        {/* 18. 块手柄与块操作菜单 block-handle(手搭真实类·依赖 hover/编辑器 gutter) */}
        <Section idx="18" zh="块手柄与块操作菜单" en="Block handle & menu" id="blockhandle">
          <p className="uk-cap uk-lead">
            对应真机:编辑器可编辑时,hover 段落/标题/列表左侧 gutter 浮出的块手柄——非空块显示类型
            chip + 六点 grip(<code>is-chip</code>),空块显示加号(<code>is-plus</code>),可折叠块带折叠三角
            (<code>fold-toggle</code>)。点击块手柄打开转换/对齐/插入菜单。手柄为 fixed portal 贴正文左侧,
            本页 override 成静态陈列。
          </p>
          <Group title="块手柄 + 菜单(非空块)" code=".block-handle-wrap / .block-handle-btn.is-chip / .bh-grip / .block-handle-menu / .bh-grid / .bh-submenu">
            <div id="view-workspace" className="uk-portal uk-blockhandle-demo" style={{ height: 520 }}>
              <div className="block-handle-wrap">
                <button className="block-handle-btn is-chip" type="button" aria-label="块操作菜单">
                  <span className="bh-chip-inner">
                    <span className="bh-type">¶</span>
                    <svg className="bh-grip" width="7" height="13" viewBox="0 0 7 13" aria-hidden="true">
                      <circle cx="1.6" cy="2.5" r="1.05" fill="currentColor" />
                      <circle cx="5.4" cy="2.5" r="1.05" fill="currentColor" />
                      <circle cx="1.6" cy="6.5" r="1.05" fill="currentColor" />
                      <circle cx="5.4" cy="6.5" r="1.05" fill="currentColor" />
                      <circle cx="1.6" cy="10.5" r="1.05" fill="currentColor" />
                      <circle cx="5.4" cy="10.5" r="1.05" fill="currentColor" />
                    </svg>
                  </span>
                </button>
                <button className="fold-toggle" type="button" aria-label="折叠下级内容">
                  <svg className="fold-caret" width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
                    <path d="M2.4 1.6L6.4 4.5L2.4 7.4Z" fill="currentColor" />
                  </svg>
                </button>
              </div>
              <div className="block-handle-menu" role="menu">
                <div className="bh-section-label">转换为</div>
                <div className="bh-grid">
                  {["正文", "H1", "H2", "H3", "•", "1.", "❝", "&lt;/&gt;", "☑", "💡"].map((g, i) => (
                    <button key={i} className="bh-grid-btn" role="menuitem" type="button" aria-label={`转换 ${g}`}>
                      <span dangerouslySetInnerHTML={{ __html: g }} />
                    </button>
                  ))}
                </div>
                <div className="bh-divider" />
                <div className="bh-submenu">
                  <button className="block-handle-item bh-submenu-trigger" role="menuitem" type="button" aria-haspopup="menu">
                    <span className="bh-icon">≡</span>
                    对齐
                    <span className="bh-caret">›</span>
                  </button>
                </div>
                <button className="block-handle-item" role="menuitem" type="button">
                  <span className="bh-icon">⧉</span>
                  复制
                </button>
                <button className="block-handle-item" role="menuitem" type="button">
                  <span className="bh-icon">✂</span>
                  剪切
                </button>
                <button className="block-handle-item is-danger" role="menuitem" type="button">
                  <span className="bh-icon">🗑</span>
                  删除
                </button>
              </div>
              {/* 对齐二级面板(hover 子菜单展开态) */}
              <div className="bh-submenu-panel" role="menu">
                <button className="block-handle-item" role="menuitem" type="button"><span className="bh-icon">⬅</span>左对齐</button>
                <button className="block-handle-item" role="menuitem" type="button"><span className="bh-icon">↔</span>居中</button>
                <button className="block-handle-item" role="menuitem" type="button"><span className="bh-icon">➡</span>右对齐</button>
              </div>
            </div>
            <p className="uk-cap uk-lead">
              证据:手柄渲染 <code>DocumentSnapshotView.tsx:2367</code>;菜单 <code>DocumentSnapshotView.tsx:2457</code>;
              CSS <code>workspace.css:1404/1470/1519</code>。空块加号态(<code>is-plus</code>)与插入子菜单
              (<code>bh-inline-insert</code>)同族,此处以非空块 + 对齐子面板代表。
            </p>
          </Group>
        </Section>

        {/* 19. 行内浮层:链接悬浮卡 + 公式编辑 popover(手搭真实类·fixed 定位) */}
        <Section idx="19" zh="行内浮层 · 链接 / 公式" en="Inline popovers" id="inlinepop">
          <p className="uk-cap uk-lead">
            对应真机:hover 正文链接出查看卡、从工具条创建/编辑链接出编辑卡(<code>link-hover-card</code>);
            点击行内/块公式出 LaTeX 编辑 popover(<code>math-edit-popover</code>,KaTeX 实时预览)。二者均为
            fixed 定位浮层,本页 override 成静态陈列。
          </p>
          <Group title="链接悬浮卡(查看态 / 编辑态)" code=".link-hover-card / .lhc-view / .lhc-edit / .lhc-url / .lhc-btn / .lhc-input">
            <div id="view-workspace" className="uk-portal uk-inlinepop-demo" style={{ height: 160 }}>
              <div className="link-hover-card">
                <div className="lhc-view">
                  <a className="lhc-url" href="#seltoolbar" onClick={(e) => e.preventDefault()}>https://qingagent.example/亚运报道</a>
                  <span className="lhc-sep" />
                  <button className="lhc-btn" type="button">编辑</button>
                  <button className="lhc-btn" type="button">移除</button>
                </div>
              </div>
              <div className="link-hover-card">
                <div className="lhc-edit">
                  <input className="lhc-input" defaultValue="https://qingagent.example" readOnly aria-label="链接地址" />
                  <button className="lhc-btn primary" type="button">保存</button>
                </div>
              </div>
            </div>
            <p className="uk-cap uk-lead">
              证据:查看卡 <code>DocumentSnapshotView.tsx:2750</code>;工具条编辑卡 <code>DocToolbar.tsx:1125</code>;
              CSS <code>workspace.css:1999</code>。
            </p>
          </Group>
          <Group title="公式编辑 popover(正常 / 错误预览)" code=".math-edit-popover / .math-edit-preview / .math-edit-preview.is-error / .math-edit-actions">
            <div id="view-workspace" className="uk-portal uk-inlinepop-demo" style={{ height: 300 }}>
              <div className="math-edit-popover">
                <textarea defaultValue={"\\frac{a}{b} + c^2"} readOnly aria-label="LaTeX 源码" />
                <div className="math-edit-preview">
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>a/b + c²(KaTeX 预览)</span>
                </div>
                <div className="math-edit-actions">
                  <button type="button">删除</button>
                  <button type="button">取消</button>
                  <button className="primary" type="button">保存</button>
                </div>
              </div>
              <div className="math-edit-popover">
                <textarea defaultValue={"\\frac{a}{b"} readOnly aria-label="LaTeX 源码" />
                <div className="math-edit-preview is-error">
                  <span>KaTeX 解析错误:缺少右花括号</span>
                </div>
                <div className="math-edit-actions">
                  <button type="button">删除</button>
                  <button type="button">取消</button>
                  <button className="primary" type="button" disabled>保存</button>
                </div>
              </div>
            </div>
            <p className="uk-cap uk-lead">
              证据:挂载 <code>DocumentSnapshotView.tsx:1106</code>;渲染 <code>MathEditPopover.tsx:78</code>;
              CSS <code>workspace.css:1969</code>。预览区真机走 KaTeX <code>renderToString</code>,本页以文字示意。
            </p>
          </Group>
        </Section>

        {/* 20. 表格编辑件:列/行头 + 插入圆点 + 选区工具条(手搭真实类·fixed portal) */}
        <Section idx="20" zh="表格编辑件 · 头 / 圆点 / 选区条" en="Table controls" id="tableedit">
          <p className="uk-cap uk-lead">
            对应真机:光标进入表格时,列头/行头常显(<code>tbl-col-hdr</code> / <code>tbl-row-hdr</code>,
            点击/拖拽选择列或行,选中态 <code>active</code>);边界圆点 hover 变插入指示并画引导线
            (<code>tbl-dot</code> + <code>tbl-dot-mark</code>);选择一列/多列或行后浮出选区工具条
            (<code>doc-toolbar tbl-sel-toolbar</code>)。均为 fixed portal,本页 override 成静态陈列并强制显出 hover 态。
          </p>
          <Group title="列/行头 + 插入圆点" code=".tbl-col-hdr(.active) / .tbl-row-hdr / .tbl-dot.tbl-dot-col / .tbl-dot-mark / --tbl-guide">
            <div id="view-workspace" className="uk-portal uk-tbl-demo" style={{ height: 200 }}>
              <div className="uk-tbl-grid">
                {/* 列头(表格上方) */}
                <div className="tbl-col-hdr active" style={{ top: -14, left: 0, width: 82, height: 12 }} />
                <div className="tbl-col-hdr" style={{ top: -14, left: 83, width: 82, height: 12 }} />
                <div className="tbl-col-hdr" style={{ top: -14, left: 166, width: 82, height: 12 }} />
                {/* 行头(表格左侧) */}
                <div className="tbl-row-hdr active" style={{ left: -14, top: 0, width: 12, height: 30 }} />
                <div className="tbl-row-hdr" style={{ left: -14, top: 31, width: 12, height: 30 }} />
                <table>
                  <tbody>
                    <tr><td /><td /><td /></tr>
                    <tr><td /><td /><td /></tr>
                  </tbody>
                </table>
                {/* 插入圆点(列右边界 / 行下边界) */}
                <button className="tbl-dot tbl-dot-col" type="button" title="插入列" style={{ top: -19, left: 82, "--tbl-guide": "80px" } as CSSProperties}>
                  <span className="tbl-dot-mark">│</span>
                </button>
                <button className="tbl-dot tbl-dot-row" type="button" title="插入行" style={{ top: 61, left: -19, "--tbl-guide": "260px" } as CSSProperties}>
                  <span className="tbl-dot-mark">─</span>
                </button>
              </div>
            </div>
            <p className="uk-cap uk-lead">
              证据:交互 <code>DocumentSnapshotView.tsx:2922</code>;渲染 <code>DocumentSnapshotView.tsx:3017</code>;
              CSS <code>workspace.css:2028/2048</code>。
            </p>
          </Group>
          <Group title="表格选区工具条" code=".doc-toolbar.on.tbl-sel-toolbar / .dt-group.dt-dropdown.tbl-color-group / .dt-text-bar / .dt-cell-fill-icon">
            <div id="view-workspace" className="uk-portal uk-tbl-demo" style={{ height: 96 }}>
              <div className="doc-toolbar on tbl-sel-toolbar" role="toolbar" aria-label="表格选区工具栏">
                <button className="dt-btn" type="button"><b>B</b></button>
                <button className="dt-btn" type="button"><i>I</i></button>
                <button className="dt-btn" type="button"><u>U</u></button>
                <button className="dt-btn" type="button"><s>S</s></button>
                <div className="dt-group dt-dropdown tbl-color-group">
                  <button className="dt-btn" type="button" title="文字颜色">
                    <span className="dt-lbl dt-hi-lbl">A<span className="dt-text-bar" /></span>
                  </button>
                </div>
                <div className="dt-group dt-dropdown tbl-color-group">
                  <button className="dt-btn" type="button" title="单元格底色">
                    <span className="dt-cell-fill-icon" aria-hidden="true"><span /></span>
                  </button>
                </div>
                <div className="dt-divider" />
                <button className="dt-btn dt-ai" type="button"><span className="dt-ai-ico">✨</span><span>修改选中文字</span></button>
                <div className="dt-divider" />
                <button className="dt-btn" type="button" style={{ color: "var(--mark)" }}>删除列</button>
              </div>
            </div>
            <p className="uk-cap uk-lead">
              证据:渲染 <code>DocumentSnapshotView.tsx:3051</code>;CSS <code>workspace.css:2083</code>,
              复用 <code>workspace.css:1234</code> 深墨工具条。颜色栅格(<code>dt-menu-table-colors</code>)展开态同族,不重复陈列。
            </p>
          </Group>
        </Section>

        {/* 21. 图片块工具条与 resize handle(pm-image-* 编辑器域全局类) */}
        <Section idx="21" zh="图片块 chrome" en="Image block chrome" id="imageblock">
          <p className="uk-cap uk-lead">
            对应真机:可编辑图片块 hover/选中时的右上工具条(左/中/右对齐 + 全屏)与右下 resize 圆点手柄;
            上传中先盖上传 overlay。<code>pm-image-*</code> 属编辑器域全局 chrome 类,本页强制显出 hover 态陈列。
          </p>
          <Group title="图片工具条 + resize handle + 上传 overlay" code=".pm-image-toolbar.pm-image-chrome / .pm-image-tool(.is-active/--wide) / .pm-image-resize-handle / .pm-image-upload-overlay">
            <div className="uk-image-demo">
              <div className="uk-image-frame">
                <span className="uk-image-ph" aria-hidden="true" />
                <div className="pm-image-toolbar pm-image-chrome" role="toolbar" aria-label="图片操作">
                  <button className="pm-image-tool is-active" type="button" aria-pressed>左</button>
                  <button className="pm-image-tool" type="button">中</button>
                  <button className="pm-image-tool" type="button">右</button>
                  <button className="pm-image-tool pm-image-tool--wide" type="button">⛶ 全屏</button>
                </div>
                <button className="pm-image-resize-handle pm-image-chrome" type="button" aria-label="调整图片宽度" />
              </div>
              <div className="uk-image-frame">
                <span className="uk-image-ph" aria-hidden="true" />
                <div className="pm-image-upload-overlay">
                  <div className="pm-image-upload-spinner" aria-hidden="true" />
                  <span className="pm-image-upload-text">上传中 62%</span>
                </div>
              </div>
              <div className="uk-image-frame">
                <span className="uk-image-ph" aria-hidden="true" />
                <div className="pm-image-upload-overlay is-error">
                  <div className="pm-image-upload-spinner" aria-hidden="true" />
                  <span className="pm-image-upload-text">上传失败</span>
                </div>
              </div>
            </div>
            <p className="uk-cap uk-lead">
              证据:渲染 <code>ImageView.tsx:80/115</code>;CSS <code>ImageView.css:38/67/94</code>。
            </p>
          </Group>
        </Section>

        {/* 22. 图表工具栏(真实生产控件) */}
        <Section idx="22" zh="图表工具栏(生产控件)" en="Diagram toolbar" id="diagram">
          <Group title="统一图表工具栏" code=".pm-diagram-tool / .is-active / --wide / -sep">
            <div className="uk-row">
              <div className="pm-diagram-svg-viewbar pm-diagram-chrome" style={{ position: "static", opacity: 1 }}>
                <button className="pm-diagram-tool is-active" aria-pressed>
                  左
                </button>
                <button className="pm-diagram-tool">中</button>
                <button className="pm-diagram-tool">右</button>
                <span className="pm-diagram-tool-sep" aria-hidden="true" />
                <button className="pm-diagram-tool">−</button>
                <button className="pm-diagram-tool">＋</button>
                <span className="pm-diagram-tool-sep" aria-hidden="true" />
                <button className="pm-diagram-tool pm-diagram-tool--wide">⛶ 全屏</button>
              </div>
            </div>
            <div className="uk-row">
              <span className="uk-cap">说明:对齐左/中/右(is-active 高亮)· 缩放 −/＋ · 全屏。统一棕色边框、直角、14px 图标。</span>
            </div>
          </Group>
        </Section>

        {/* 23. 图表块可视化(真实生产控件 · Mermaid 真相源 + React Flow overlay) */}
        <Section idx="23" zh="图表块(可视化)" en="Diagram block" id="diagramblock">
          <p className="uk-cap" style={{ display: "block", marginBottom: 12 }}>
            生产 <code>DiagramRenderer</code>:Mermaid source 为唯一真相源。节点-边类图
            (flowchart/state/er/class/mindmap)走 <code>GraphDiagramView</code>(React Flow 可拖拽 overlay);
            其余(如 sequence)走 <code>MermaidPreview</code> 静态 SVG。工具栏即上一节控件。
          </p>
          <Group title="节点-边图 · React Flow" code="DiagramRenderer → GraphDiagramView">
            <div className="uk-diagram-sample">
              <DiagramRenderer source={diagramFlowchart} readOnly />
            </div>
          </Group>
          <Group title="时序图 · 静态 SVG" code="DiagramRenderer → MermaidPreview">
            <div className="uk-diagram-sample">
              <DiagramRenderer source={diagramSequence} readOnly />
            </div>
          </Group>
        </Section>

        {/* 24. 图表块编辑件:左下入口(pm-*) + 图编辑器上下文条(graph-diagram-*) */}
        <Section idx="24" zh="图表块编辑件" en="Diagram edit chrome" id="diagramedit">
          <p className="uk-cap uk-lead">
            对应真机:图表块左下的「可视化编辑 / 编辑 Mermaid」入口(<code>pm-diagram-view-actions</code>,
            仅 editable 下 hover 出现),以及进入全屏可视化编辑器后选中节点/连线时的上下文工具条
            (<code>graph-diagram-context</code>,根据空间上/下翻转,二级菜单出 <code>graph-diagram-popover</code>)。
            均为条件浮层,本页 override 成静态陈列。
          </p>
          <Group title="图表块左下编辑入口" code=".pm-diagram-view-actions / .pm-diagram-view-btn / .pm-diagram-view-btn--ghost">
            <div className="uk-diagramedit-demo">
              <div className="pm-diagram-view-actions" aria-label="图表操作">
                <button className="pm-diagram-view-btn" type="button">可视化编辑</button>
                <button className="pm-diagram-view-btn pm-diagram-view-btn--ghost" type="button">编辑 Mermaid</button>
              </div>
            </div>
            <p className="uk-cap uk-lead">
              证据:渲染 <code>DiagramView.tsx:316</code>;CSS <code>DiagramView.css:195</code>。
            </p>
          </Group>
          <Group title="图编辑器上下文条(节点 · 形状栅格展开)" code=".graph-diagram-context.graph-diagram-toolbar.graph-diagram-context--node / .graph-diagram-toolbar__button / .graph-diagram-popover / .graph-diagram-shape-grid">
            <div className="uk-portal uk-diagramedit-demo" style={{ height: 260, background: "rgba(246,241,231,.98)" }}>
              <div className="graph-diagram-context graph-diagram-toolbar graph-diagram-context--node graph-diagram-context--below" aria-label="节点上下文操作">
                <div className="graph-diagram-toolbar__row" role="toolbar" aria-label="节点样式工具栏">
                  <button className="graph-diagram-toolbar__button is-active" type="button" aria-haspopup="dialog">
                    <svg className="graph-diagram-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
                    <span className="graph-diagram-toolbar__value">矩形</span>
                    <span className="graph-diagram-toolbar__caret" aria-hidden="true">▾</span>
                  </button>
                  <button className="graph-diagram-toolbar__button" type="button">
                    <svg className="graph-diagram-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
                    <span className="graph-diagram-toolbar__caret" aria-hidden="true">▾</span>
                  </button>
                  <button className="graph-diagram-toolbar__button" type="button">
                    <svg className="graph-diagram-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M4 12l4-6h8l4 6-4 6H8Z" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
                    <span className="graph-diagram-toolbar__caret" aria-hidden="true">▾</span>
                  </button>
                  <button className="graph-diagram-toolbar__button" type="button">…更多</button>
                </div>
                <div className="graph-diagram-popover" role="dialog" aria-label="形状选择">
                  <div className="graph-diagram-shape-grid" aria-label="节点形状">
                    {["矩形", "圆", "菱形", "六边形", "平行四边形", "双圆"].map((s, i) => (
                      <button key={s} className={`graph-diagram-shape-btn${i === 0 ? " is-active" : ""}`} type="button" aria-pressed={i === 0}>{s}</button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </Group>
          <Group title="图编辑器上下文条(连线 · 更多菜单展开)" code=".graph-diagram-context--edge / .graph-diagram-popover--menu / .graph-diagram-menu-item(.is-danger)">
            <div className="uk-portal uk-diagramedit-demo" style={{ height: 220, background: "rgba(246,241,231,.98)" }}>
              <div className="graph-diagram-context graph-diagram-toolbar graph-diagram-context--edge graph-diagram-context--below" aria-label="连线上下文操作">
                <div className="graph-diagram-toolbar__row" role="toolbar" aria-label="连线样式工具栏">
                  <button className="graph-diagram-toolbar__button" type="button">线</button>
                  <button className="graph-diagram-toolbar__button" type="button">箭头</button>
                  <button className="graph-diagram-toolbar__button" type="button">标签</button>
                  <button className="graph-diagram-toolbar__button is-active" type="button">…更多</button>
                </div>
                <div className="graph-diagram-popover graph-diagram-popover--menu" role="menu" aria-label="连线更多操作">
                  <button className="graph-diagram-menu-item" role="menuitem" type="button"><span>反转方向</span><kbd>R</kbd></button>
                  <button className="graph-diagram-menu-item" role="menuitem" type="button"><span>重置样式</span><kbd>⌥R</kbd></button>
                  <button className="graph-diagram-menu-item is-danger" role="menuitem" type="button"><span>删除连线</span><kbd>Del</kbd></button>
                </div>
              </div>
            </div>
            <p className="uk-cap uk-lead">
              证据:全屏编辑器 <code>GraphDiagramView.tsx:1628</code>;节点条 <code>:1716</code>;连线条 <code>:1837</code>;
              CSS <code>graphDiagram.css:423/508/594</code>。改父提示态(<code>graph-diagram-context__hint</code>)同族,不重复陈列。
            </p>
          </Group>
        </Section>

        {/* 25. 修订审批系:PatchNav 真组件 + 三态 diff / patch-popup / wf-patch-ins-wrap / wf-blockmark 真实类 */}
        <Section idx="25" zh="修订审批系" en="Patch review system" id="patchsys">
          <p className="uk-cap uk-lead">
            审批条走生产 <code>PatchNav</code>(单处 / 多处两态:多处才出「上/下一处」)。
            勘误落地:<b>patch-popup 悬浮层只有「撤销」,顶部 PatchNav 只保留导航 / 提交 / 放弃全部</b>;
            diff 只保留 <code>data-patch-state="replace|insert|delete"</code> 三态。
          </p>
          <div id="view-workspace" className="uk-sp-view" style={{ height: "auto", overflow: "visible" }}>
            <div className="ws-left uk-sp-scope">
              <div className="uk-sp-wrap" style={{ padding: "8px 0 0" }}>
                <section className="uk-sp-section">
                  <h2 className="uk-sp-h2">审批条 PatchNav<span className="uk-sp-hint">单处(无导航)/ 多处(有上下一处)</span></h2>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">单处修改</div>
                    <div className="uk-sp-rowbody">
                      <PatchNav remainingCount={1} totalCount={1} activePatchIndex={0} onJumpPrev={() => {}} onJumpNext={() => {}} onRejectAll={() => {}} onCommit={() => {}} />
                    </div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">多处修改(3 处)</div>
                    <div className="uk-sp-rowbody">
                      <PatchNav remainingCount={3} totalCount={3} activePatchIndex={1} onJumpPrev={() => {}} onJumpNext={() => {}} onRejectAll={() => {}} onCommit={() => {}} />
                    </div>
                  </div>
                </section>
                <section className="uk-sp-section">
                  <h2 className="uk-sp-h2">
                    整篇改写审核条 WholeDocReviewNav
                    <span className="uk-sp-hint">大改/整篇改写审核态 · 新版/旧版互斥切换 · 应用新版 / 退回旧版</span>
                  </h2>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">新版(默认)</div>
                    <div className="uk-sp-rowbody">
                      <WholeDocReviewNav reviewScopeKey="uikit-new" version="new" onVersionChange={() => {}} onApply={() => {}} onRevert={() => {}} />
                    </div>
                  </div>
                  <div className="uk-sp-row">
                    <div className="uk-sp-rowlbl">旧版(thumb 滑到旧版)</div>
                    <div className="uk-sp-rowbody">
                      <WholeDocReviewNav reviewScopeKey="uikit-old" version="old" onVersionChange={() => {}} onApply={() => {}} onRevert={() => {}} />
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>
          <Group title="patch-popup 悬浮层(勘误:只有撤销)" code=".patch-hover-popup.is-visible + .patch-popup-title/original/badge/actions · 仅「撤销」">
            <div id="view-workspace" className="uk-portal" style={{ height: 200 }}>
              <div className="patch-hover-popup is-visible" style={{ position: "absolute", top: 20, left: 20, background: "var(--bg-canvas)", border: "1px solid var(--line-2)", boxShadow: "var(--shadow-2)", padding: 12, maxWidth: 320, display: "flex", flexDirection: "column", gap: 7 }}>
                <span className="patch-popup-title">#2 · 替换</span>
                <div className="patch-popup-original">
                  <span className="patch-popup-label">原文</span>
                  <div className="patch-popup-original-text">总之这届办得很成功。</div>
                </div>
                <div className="patch-popup-actions">
                  <button className="patch-popup-btn" type="button">撤销</button>
                </div>
              </div>
            </div>
          </Group>
          <Group title="三态正文标记" code="[data-patch-state=replace|insert|delete] / .wf-patch-ins / .patch-del-cursor">
            <div id="view-workspace" style={{ background: "transparent" }}>
              <div className="wf-doc" style={{ fontSize: 14 }}>
                <p>
                  替换:
                  <span className="wf-patch-replace-wrap" data-patch-state="replace"><span className="wf-patch-ins">新内容</span></span>
                  {" "}新增:
                  <span className="wf-patch-ins-wrap" data-patch-state="insert"><span className="wf-patch-add-badge">新增</span><span className="wf-patch-ins">补充内容</span></span>
                  {" "}删减:
                  <span className="wf-patch-del-marker" data-patch-state="delete"><span className="patch-del-cursor" /></span>
                </p>
              </div>
            </div>
          </Group>
        </Section>

        {/* ══════════════ 域二 · 文档页 — 输入区(底部) ══════════════ */}

        {/* 26. 输入 */}
        <Section idx="26" zh="输入" en="Input" id="input">
          <p className="uk-cap uk-lead">
            对应真机:文档页底部输入框——技能、文件、发送三件套与已关联文件面板。
          </p>
          <Group title="文本框 / 多行" code=".wf-input">
            <div className="uk-col" style={{ width: 420, maxWidth: "100%" }}>
              <div className="wf-input" style={{ width: "100%" }}>
                <input type="text" placeholder="单行输入 · placeholder" />
              </div>
              <div className="wf-input" style={{ width: "100%" }}>
                <textarea rows={3} placeholder="多行输入 · 聚焦时有焦点环(:focus-within)" />
              </div>
            </div>
          </Group>
        </Section>

        {/* 27. 发送 / 停止 / 未配置 key 门禁(手搭真实类·发送键红覆盖需 ws-input-tools 作用域) */}
        <Section idx="27" zh="发送 · 停止 · 门禁" en="Send / Stop / NoKey gate" id="send">
          <p className="uk-cap uk-lead">
            对应真机:输入区右侧发送/停止互斥——空闲显<b>发送</b>(<code>wf-btn primary small</code>,
            工作区覆盖成朱红描边、2px 圆角);生成中且输入为空显<b>停止</b>(<code>wf-btn ghost small</code>);
            未配置模型 key 时发送禁用,hover 或按快捷键被拦时强制弹出门禁气泡(<code>nokey-gate</code> +
            <code>nokey-tip</code>)。发送键红覆盖依赖 <code>#view-workspace .ws-input-tools .wf-btn.primary</code>
            作用域,故整组包工作区输入行小舞台。
          </p>
          <Group title="发送 / 停止互斥" code="#view-workspace .ws-input-tools .wf-btn.primary(发送)/ .wf-btn.ghost.small(停止)">
            <div id="view-workspace" className="uk-portal uk-send-demo" style={{ height: 120 }}>
              <div className="ws-input-tools">
                <button className="wf-btn primary small" type="button">发送 →</button>
                <button className="wf-btn ghost small" type="button">停止</button>
                <button className="wf-btn primary small" type="button" disabled>发送 →</button>
              </div>
            </div>
            <p className="uk-cap uk-lead">
              证据:发送/停止 <code>ChatInput.tsx:1129</code>;CSS <code>workspace-ink-skin.css:797</code>;
              基座 <code>ui-kit/components.css</code>。
            </p>
          </Group>
          <Group title="未配置 key 门禁气泡(强制态)" code=".nokey-gate.is-forced / .nokey-tip / .nokey-tip-text / .nokey-tip-btn">
            <div id="view-workspace" className="uk-portal uk-send-demo" style={{ height: 150 }}>
              <div className="ws-input-tools">
                <span className="nokey-gate is-forced">
                  <button className="wf-btn primary small" type="button" disabled>发送 →</button>
                  <span className="nokey-tip" role="tooltip">
                    <span className="nokey-tip-text">还没配置模型 key,无法开始写作。</span>
                    <button className="nokey-tip-btn" type="button">去首页配置 →</button>
                  </span>
                </span>
              </div>
            </div>
            <p className="uk-cap uk-lead">
              证据:挂载 <code>ChatInput.tsx:1145</code>;渲染 <code>system/modelKeyGate.tsx:71</code>;CSS <code>app.css:47</code>。
            </p>
          </Group>
        </Section>

        {/* 28. 菜单 / 浮层 —— 指路节:不再手搭任何虚构菜单 */}
        <Section idx="28" zh="菜单 · 浮层(指路)" en="Menu / Floaty — see §35/§30" id="menu">
          <p className="uk-cap uk-lead">
            现役菜单的真相源:<code>qa-skill-menu</code>(技能菜单真组件,见 <b>35 节</b>)、
            <code>ws-export-menu</code>(导出菜单,见 <b>30 节</b>)、文件菜单双态(见 <b>35 节</b>)。
            墓碑:旧「插入菜单」demo 是虚构内容,已撤下;<code>.wf-floaty</code> 当前唯一活消费者是
            FolderSourceControl 的已连接文件夹 hover 卡(35 节以该真实形态陈列),随「文件入口融合」
            退役后转死件(A2-2)。
          </p>
        </Section>

        {/* 29. 已关联文件 LinkedFilesPanel(真组件) */}
        <Section idx="29" zh="已关联文件 LinkedFilesPanel" en="Linked files" id="asset">
          <p className="uk-cap uk-lead">
            生产输入框底部的现役入口是 <code>LinkedFilesPanel</code>:收起时显示 34px 附近的细条摘要,
            展开后渲染上传文件组、已连接文件夹根行、文件树和底部 34px 信息条。皮肤来自
            <code>#view-workspace .lf-*</code> 作用域,本节包进独立 <code>#view-workspace</code> +
            <code>.ws-left</code> + <code>.ws-input-wrap</code>,让 <code>workspace.css</code> 与真机同源生效。
          </p>
          <p className="uk-cap uk-lead">
            旧顶部平铺网格 <code>AssetPanel/PanelCard</code> 已在 file-entry 合并退役且导出删除。
            <code>AssetPanel.tsx</code> 现仅保留 <code>FileKind</code> / <code>fileKind</code> /
            <code>FileIcon</code>;全库 grep 仍有 <code>LinkedFilesPanel.tsx</code> 与
            <code>AssetPreview.tsx</code> 复用这些文件图标工具,因此只把旧网格标注为退役,不把文件图标误判为死件。
          </p>
          <Group title="收起摘要 + 展开树态" code="LinkedFilesPanel.tsx → .lf-bar / .lf-panel / .lf-folder-dot / .lf-info">
            <div id="view-workspace" className="uk-linkedfiles-demo">
              <div className="ws-left uk-sp-scope">
                <div className="ws-input-wrap uk-linkedfiles-input-wrap">
                  <LinkedFilesPanelDemo />
                </div>
              </div>
            </div>
          </Group>
        </Section>

        {/* ══════════════ 域三 · 顶栏 · 导出 ══════════════ */}

        {/* 30. 导出菜单(真实生产控件) */}
        <Section idx="30" zh="导出菜单(生产控件)" en="Export menu" id="export">
          <p className="uk-cap uk-lead">
            对应真机:文档纸右上角图标顶栏与导出下拉。
          </p>
          <p className="uk-cap uk-lead">
            皮肤来自 <code>#view-workspace .ws-doc-topbar/.ws-export-anchor/.ws-export-menu</code> 作用域:
            导出按钮贴文档纸右上角,菜单为深色暖灰纵向下拉;本节单独包 <code>#view-workspace</code> 小舞台,
            不影响其它节。
          </p>
          <Group title="导出二级菜单" code="#view-workspace .ws-export-anchor / .ws-export-menu / .ws-export-item">
            <div id="view-workspace" className="uk-portal uk-export-demo" style={{ height: 300 }}>
              <div className="uk-export-paper" aria-hidden="true">
                <p>苏堤烟柳织翠帘,桃花照水差红妆。</p>
                <p>远山含黛,近波漾碧,一叶扁舟划破镜湖。</p>
              </div>
              <div className="ws-doc-topbar">
                <div className="ws-export-anchor">
                  <button className="ws-doc-btn" type="button" title="导出" aria-haspopup="menu" aria-expanded="true">
                    <ExportGlyph />
                  </button>
                  <div className="ws-export-menu" role="menu" data-wf="ExportMenu">
                    <button className="ws-export-item" type="button" role="menuitem">导出 PDF</button>
                    <button className="ws-export-item" type="button" role="menuitem">导出 Word</button>
                    <button className="ws-export-item" type="button" role="menuitem">导出 HTML</button>
                    <button className="ws-export-item" type="button" role="menuitem">导出 Markdown</button>
                    <button className="ws-export-item" type="button" role="menuitem">导出 TXT</button>
                    <div className="ws-export-sep" aria-hidden="true" />
                    <button className="ws-export-item ws-export-item--platform" type="button" role="menuitem">导出到飞书</button>
                  </div>
                </div>
              </div>
            </div>
          </Group>
        </Section>

        {/* ══════════════ 域四 · 全局反馈 ══════════════ */}

        {/* 31. Toast · 全局反馈(统一家族定稿 + 现役三套标记为清洗对象) */}
        <Section idx="31" zh="Toast · 全局反馈(统一家族)" en="Toast — unified" id="toast">
          <p className="uk-cap uk-lead">
            对应真机:全局 toast 与模态弹框,任何页面都可能出现。
          </p>
          <p className="uk-cap uk-lead">
            规范定稿:全站唯一 Toast 家族 <code>.qa-toast</code>,双形态——<b>瞬时</b>(自动退场)与
            <b>常驻</b>(带动作入口、必带手动关闭)。造型:直角、宋体、暖墨玻璃底、左侧 2px 语义色条
            (金=告知 / 绿=成功 / 橙=有损降级 / 红=失败)。位置统一:底部居中、输入区上方,向上堆叠,
            同屏至多 3 条(新顶旧)。瞬时 2.4s 自动退场、hover 暂停计时;失败默认走常驻。
            现已迁入生产 <code>ToastProvider</code>，流级错误也已归入本族常驻形态；
            旧 <code>wf-toast</code> / <code>doc-ver-toast</code> 不再渲染；
            <code>ccx-toast</code> 属新建页硬豁免，留待用户自迁。
          </p>
          <Group title="瞬时 · 自动退场" code=".qa-toast · role=status · 2.4s · 无关闭钮">
            <div className="uk-col" style={{ gap: 8 }}>
              <div className="qa-toast" role="status">已复制到剪贴板</div>
              <div className="qa-toast success" role="status">PDF 已导出</div>
              <div className="qa-toast warn" role="status">分栏在 Markdown 中已降级为普通段落</div>
            </div>
          </Group>
          <Group title="常驻 · 带动作" code=".qa-toast.sticky · role=alert(失败) · 手动关 · 至多一个动作">
            <div className="uk-col" style={{ gap: 8 }}>
              <div className="qa-toast sticky error" role="alert">
                <span className="qa-toast-msg">导出失败,请检查网络后重试</span>
                <button className="qa-toast-act" type="button">重试</button>
                <button className="qa-toast-x" type="button" aria-label="关闭">×</button>
              </div>
              <div className="qa-toast sticky" role="status">
                <span className="qa-toast-msg">配图已生成并插入文档</span>
                <button className="qa-toast-act" type="button">查看</button>
                <button className="qa-toast-x" type="button" aria-label="关闭">×</button>
              </div>
            </div>
          </Group>
          <Group title="用哪种反馈 · 决策规则(铁律四)" code="Toast 不是万能容器">
            <table className="uk-map">
              <thead>
                <tr>
                  <th>形态</th>
                  <th>什么时候用</th>
                  <th>例子</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>瞬时 toast</td>
                  <td>单向告知,用户无需行动</td>
                  <td>复制成功 / 导出完成 / 已回填输入框</td>
                </tr>
                <tr>
                  <td>常驻 toast</td>
                  <td>需要被看见、且可能要行动(带入口)</td>
                  <td>导出失败+重试 / 后台任务完成+查看</td>
                </tr>
                <tr>
                  <td>内联提示</td>
                  <td>与具体控件/区域强绑定的状态</td>
                  <td>表单校验 / 素材树里的解析失败行</td>
                </tr>
                <tr>
                  <td>确认弹层</td>
                  <td>不可逆动作</td>
                  <td>删除素材 / 断开文件夹</td>
                </tr>
              </tbody>
            </table>
          </Group>
        </Section>

        {/* 32. 模态 —— 现役唯一模态 AuthTokenGate 真组件收录;抽屉死件只留墓碑 */}
        <Section idx="32" zh="模态(真组件)" en="Modal — AuthTokenGate" id="overlay">
          <p className="uk-cap uk-lead">
            <code>wf-modal</code> 全站唯一现役使用点 = <code>AuthTokenGate</code>(Web 端访问令牌门禁)。
            下方即 <b>import 的真组件</b>(内容非虚构):组件本是 401 事件门控,此处以
            <code>forceOpen</code> 常开陈列;demo 隔离不监听全局 401,也不读写 authGate pending。
            其圆角(--r-lg)不符铁律二,清洗阶段随现役弹层统一削直角。
          </p>
          <Group title="访问令牌门禁(真组件 AuthTokenGate)" code="system/AuthTokenGate.tsx → ui-kit Modal(.wf-modal.open)">
            <div className="uk-portal" style={{ height: 300 }}>
              <AuthGateDemo />
            </div>
          </Group>
          <p className="uk-cap uk-lead">
            墓碑:右侧抽屉 <code>.wf-drawer</code> / <code>.wf-overlay-bg</code> 及 Drawer.tsx/OverlayBg.tsx
            已物理删除(0704 style-cleanup fd4814c4),CSS 快照存档见 39 节;生产设置面板走 overlays/settings 自有实现。
          </p>
        </Section>

        {/* ══════════════ 附录 · 原子矩阵(每变体锚真实使用点) ══════════════ */}

        {/* 33. 按钮全矩阵(仅陈列真实使用点,零使用组合下墓碑) */}
        <Section idx="33" zh="按钮全矩阵" en="Button — full matrix" id="btnmatrix">
          <p className="uk-cap uk-lead">
            只陈列 grep 到业务组件使用点的 <code>.wf-btn</code> 组合;每个样张 caption 写明锚点。
            <code>lg</code> / <code>square</code> / <code>icon</code> 只在 ui-kit 库存 API 中存在,没有生产界面使用点,撤到节尾墓碑。
          </p>
          {BTN_MATRIX_GROUPS.map((g) => (
            <div className="uk-group" key={g.title}>
              <h3>{g.title}<code>{g.code}</code></h3>
              <div className={`uk-stage${g.dark ? " uk-dark" : ""}`}>
                <table className="uk-btn-matrix">
                  <thead>
                    <tr>
                      <th>组合</th>
                      <th>样张</th>
                      <th>真实使用点</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.samples.map((sample) => (
                      <tr key={`${g.title}-${sample.label}-${sample.cap}`}>
                        <td className="uk-btn-matrix-lbl">{sample.label}</td>
                        <td>
                          <button className={sample.className} disabled={sample.disabled}>{sample.text}</button>
                        </td>
                        <td>
                          <span className="uk-cap">{sample.cap}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <p className="uk-cap uk-lead">
            {BTN_MATRIX_TOMBSTONES.map((combo) => (
              <span key={combo}>
                墓碑:<code>{combo}</code> 组合零生产使用,不陈列。{" "}
              </span>
            ))}
          </p>
        </Section>

        {/* 34. 输入区原子(暗墨输入条真实作用域) */}
        <Section idx="34" zh="输入区原子" en="Input-bar atoms" id="inputatom">
          <p className="uk-cap uk-lead">
            输入条真实落在对话区暗墨底上,故整组包进 <code>#view-workspace .ws-left</code> 作用域取真实皮肤。
            覆盖:输入外框 <code>ws-input-wrap / -morph</code>、工具行 <code>ws-input-tools</code>、
            药丸按钮 <code>ws-pill</code>(常态 / is-active / 禁用)、图标 <code>ws-tool-ico</code>、
            导出锚点 <code>ws-export-anchor</code>,以及输入框内联 <code>chat-chip</code> 各 kind。
          </p>
          <div id="view-workspace" className="uk-sp-view" style={{ height: "auto", overflow: "visible" }}>
            <div className="ws-left uk-sp-scope">
              <div className="uk-sp-wrap" style={{ padding: "10px 14px" }}>
                <Group title="输入框内联 chip · 真实 kind" code=".chat-chip[data-kind] / .c-ico / .c-label / .c-tag / .c-x">
                  <div className="chat-edit" style={{ minHeight: 0, padding: 0 }}>
                    帮我把
                    <span className="chat-chip" data-kind="sel">
                      <span className="c-ico">❝</span>
                      <span className="c-label">选中的这段</span>
                      <span className="c-x">×</span>
                    </span>
                    结合
                    <span className="chat-chip" data-kind="attach">
                      <span className="c-ico">📎</span>
                      <span className="c-label">赛事手册.pdf</span>
                      <span className="c-x">×</span>
                    </span>
                    与
                    <span className="chat-chip" data-kind="mention">
                      <span className="c-ico">@</span>
                      <span className="c-label">第 3 章</span>
                      <span className="c-x">×</span>
                    </span>
                    补背景;另附
                    <span className="chat-chip chat-chip-longtext" data-kind="longtext">
                      <span className="c-ico">¶</span>
                      <span className="c-label">长文本 · 1.2k 字</span>
                      <span className="c-x">×</span>
                    </span>
                    。
                  </div>
                  <div className="uk-row">
                    <span className="uk-cap">
                      sel / attach / mention · ChatInput makeChatChipNode; longtext · system/longText + ChatMessageList。
                    </span>
                  </div>
                </Group>
                <p className="uk-cap uk-lead">
                  墓碑:<code>{'.chat-chip[data-kind="skill"]'}</code> / <code>.c-skill-ico</code> / <code>.c-skill-label</code>
                  组合零生产使用,不陈列;真实技能引用当前走 <code>data-kind="mention"</code> +
                  <code>c-ico/c-label/c-tag/c-x</code>。
                </p>
                <Group title="输入外框 + 工具行 + 药丸" code=".ws-input-wrap / .ws-input-morph / .ws-input-tools / .ws-pill">
                  <div className="ws-input-wrap">
                    <div className="ws-input-morph">
                      <div className="chat-edit" style={{ minHeight: 28 }}>写点什么…</div>
                      <div className="ws-input-tools">
                        <button className="wf-btn small ghost ws-pill" type="button">
                          <span className="ws-tool-ico">＋</span>素材
                        </button>
                        <button className="wf-btn small ghost ws-pill is-active" type="button">技能</button>
                        <span className="ws-export-anchor">
                          <button className="wf-btn small ghost ws-pill" type="button" disabled>导出</button>
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="uk-row">
                    <span className="uk-cap">
                      ws-input-wrap/morph/tools · WorkspacePage 输入区; ws-pill/ws-tool-ico · ChatInput 技能/文件/文件夹;
                      ws-export-anchor · WorkspacePage 文档顶栏导出锚点。
                    </span>
                  </div>
                </Group>
              </div>
            </div>
          </div>
        </Section>

        {/* 35. 菜单浮层原子:技能菜单真组件 + 文件菜单双态真实类 */}
        <Section idx="35" zh="菜单浮层原子" en="Menu / Floaty atoms" id="menuatom">
          <p className="uk-cap uk-lead">
            技能菜单走生产 <code>SkillMenu</code> 真组件(行态:普通 / 键盘高亮 is-active / 空);
            文件菜单按已定稿的「文件入口融合」双态——未连接=首连引导弹层(<code>ws-folder-intro-modal</code>),
            已连接=hover 卡(含断开)。文件样本皮肤来自 <code>#view-workspace .ws-folder-*</code> 与共享
            <code>folder-control.css</code>,故各自包工作区作用域小舞台。
          </p>
          <Group title="技能菜单 SkillMenu(真组件)" code=".qa-skill-menu / .qa-skill-row.is-active / .qa-skill-empty">
            <div className="uk-row" style={{ alignItems: "flex-start", gap: 28 }}>
              <div style={{ position: "relative", width: 280, minHeight: 220 }}>
                <SkillMenu actions={skillActions} onPick={() => {}} selectedIndex={1} onHoverIndex={() => {}} />
                <span className="uk-cap" style={{ position: "absolute", bottom: -18 }}>SkillMenu.tsx:165/173 · 第 2 行键盘高亮(is-active)</span>
              </div>
              <div style={{ position: "relative", width: 280, minHeight: 80 }}>
                <SkillMenu actions={[]} onPick={() => {}} />
                <span className="uk-cap" style={{ position: "absolute", bottom: -18 }}>SkillMenu.tsx:167 · 空态 qa-skill-empty</span>
              </div>
            </div>
          </Group>
          <Group title="文件菜单 · 未连接(首连引导弹层)" code=".ws-folder-wrap / .ws-folder-intro-modal / .ws-folder-intro-point / .ws-folder-check">
            <div id="view-workspace" className="uk-portal uk-folder-demo" style={{ height: 320 }}>
              <div className="ws-input-tools uk-folder-tools">
                <span className="ws-folder-wrap">
                  <button className="wf-btn small ghost ws-pill ws-folder-btn" type="button">
                    <span className="ws-tool-ico">🗀</span>文件夹
                  </button>
                </span>
              </div>
              <div className="ws-folder-modal-overlay" style={{ position: "absolute" }}>
                <div className="ws-folder-intro-modal">
                  <div className="ws-folder-modal-icon" aria-hidden="true">🗀</div>
                  <h3>连接一个本地文件夹</h3>
                  <div className="ws-folder-intro-point"><span>·</span><p>文件<b>始终留在你的电脑上</b>,不会被上传或保存副本。</p></div>
                  <div className="ws-folder-intro-point"><span>·</span><p>只有助手实际读到的文件才会被即时解析。</p></div>
                  <div className="ws-folder-intro-point"><span>·</span><p>文件夹里的增删改,助手下次都能读到最新。</p></div>
                  <div className="ws-folder-modal-foot">
                    <label className="ws-folder-check">
                      <input type="checkbox" />不再提示
                    </label>
                    <button type="button" className="ws-folder-modal-primary">选择文件夹</button>
                    <button type="button" className="ws-folder-modal-secondary">以后再说</button>
                  </div>
                </div>
              </div>
            </div>
            <div className="uk-row">
              <span className="uk-cap">FolderSourceControl.tsx:465 · 首连引导弹层; 同一 modal family 也被 HomePage 删除确认复用。</span>
            </div>
          </Group>
          <Group title="文件菜单 · 已连接(hover 卡 · 含断开)" code=".wf-floaty.ws-folder-popover(FolderSourceControl.tsx:424 · hover 才现,census 采不到)">
            <div id="view-workspace" className="uk-portal uk-folder-demo uk-force-popover" style={{ height: 280 }}>
              <div className="ws-input-tools uk-folder-tools uk-folder-tools--connected">
                <span className="ws-folder-wrap">
                  <button className="wf-btn small ghost ws-pill ws-folder-btn is-active" type="button">
                    <span className="ws-tool-ico">🗀</span>文件夹
                    <span className="ws-folder-dot" aria-hidden="true" />
                  </button>
                  <div className="wf-floaty ws-folder-popover" role="tooltip">
                    <div className="ws-folder-popover-head">
                      <span className="ws-folder-popover-icon">🗀</span>
                      <span className="ws-folder-popover-name">亚运素材</span>
                    </div>
                    <div className="ws-folder-popover-path">~/Documents/亚运素材</div>
                    <div className="ws-folder-popover-meta">32 个文件</div>
                    <div className="ws-folder-popover-divider" aria-hidden="true" />
                    <button type="button" className="ws-folder-popover-disconnect">断开连接</button>
                    <div className="ws-folder-popover-arrow" aria-hidden="true" />
                  </div>
                </span>
              </div>
            </div>
            <div className="uk-row">
              <span className="uk-cap">
                现役·条件变体:hover 才出现,census 42 态采不到;生产渲染点 FolderSourceControl.tsx:424。
                该卡随「文件入口融合」退役后连同 .wf-floaty 转死件(A2-2)。
              </span>
            </div>
          </Group>
        </Section>

        {/* 36. 杂项原子:分隔线 / 选区 / 阴影 / 加载点 */}
        <Section idx="36" zh="杂项原子" en="Misc atoms" id="misc">
          <Group title="分隔线" code=".ws-export-sep / .pm-diagram-tool-sep / dashed line">
            <div className="uk-col" style={{ width: 320, maxWidth: "100%" }}>
              <div id="view-workspace" className="uk-export-sep-scope">
                <div className="ws-export-sep" />
              </div>
              <span className="uk-cap">ws-export-sep · ExportMenu 平台分组分隔</span>
              <div className="pm-diagram-svg-viewbar pm-diagram-chrome" style={{ position: "static", opacity: 1, width: "fit-content" }}>
                <button className="pm-diagram-tool">A</button>
                <span className="pm-diagram-tool-sep" aria-hidden="true" />
                <button className="pm-diagram-tool">B</button>
              </div>
              <span className="uk-cap">pm-diagram-tool-sep · MermaidPreview / GraphDiagramView 工具栏竖分隔</span>
            </div>
          </Group>
          <Group title="选区高亮 / 加载点" code=".wf-sel / .chat-loading-dots">
            <div className="uk-row">
              <p style={{ margin: 0 }}>
                文档内 <span className="wf-sel">选区高亮</span>
              </p>
              <span className="chat-loading-dots" style={{ display: "inline-flex", gap: 4 }}><span>·</span><span>·</span><span>·</span></span>
            </div>
            <div className="uk-row">
              <span className="uk-cap">
                wf-sel · DocumentSnapshotView 选区 span; chat-loading-dots · ChatMessageList / BigPlanPanel / ThinkingMarquee。
              </span>
            </div>
          </Group>
        </Section>

        {/* ══════════════ 档案边界 ══════════════ */}

        {/* 37. 现役 · 条件变体(图表节点形状 + 首页季节植物) */}
        <Section idx="37" zh="现役 · 条件变体" en="Live · conditional variants" id="cond">
          <p className="uk-cap uk-lead">
            这些类现役,但只在特定条件下渲染(节点选中才出把手、特定 Mermaid 形状、某季节),
            census 常采不到。此处用真实类名<b>强制平铺</b>陈列,证明其现役。
          </p>
          <Group title="图表节点形状 + 拖拽把手" code=".graph-diagram-node--rect/circle/diamond/hexagon/parallelogram/doublecircle / .graph-diagram-handle--t/r/b/l">
            <div className="uk-node-shapes">
              {([
                ["rect", "矩形"],
                ["circle", "圆"],
                ["diamond", "菱形"],
                ["hexagon", "六边形"],
                ["parallelogram", "平行四边形"],
                ["doublecircle", "双圆"],
              ] as Array<[string, string]>).map(([shape, zh]) => (
                <div className="uk-node-cell" key={shape}>
                  <div className={`graph-diagram-node--${shape}`} style={{ width: 84, height: 56, border: "1.5px solid var(--mark)", background: "var(--mark-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--ink-1)" }}>
                    <span className="graph-diagram-node-label">{zh}</span>
                  </div>
                  <span className="uk-cap">node--{shape}</span>
                </div>
              ))}
              <div className="uk-node-cell">
                <div className="uk-node-box">
                  <div className="graph-diagram-node--rect" style={{ position: "absolute", inset: 8, border: "1.5px solid var(--mark)", background: "var(--mark-soft)" }} />
                  <span className="graph-diagram-handle-slot--t" style={handleSlotStyle("t")}><span className="graph-diagram-handle--t" style={HANDLE_DOT} /></span>
                  <span className="graph-diagram-handle-slot--r" style={handleSlotStyle("r")}><span className="graph-diagram-handle--r" style={HANDLE_DOT} /></span>
                  <span className="graph-diagram-handle-slot--b" style={handleSlotStyle("b")}><span className="graph-diagram-handle--b" style={HANDLE_DOT} /></span>
                  <span className="graph-diagram-handle-slot--l" style={handleSlotStyle("l")}><span className="graph-diagram-handle--l" style={HANDLE_DOT} /></span>
                </div>
                <span className="uk-cap">选中态 · 四向把手</span>
              </div>
            </div>
          </Group>
          <Group title="设置面板 qj-sheet(首页设置抽屉 · 真实类)" code=".qj-sheet / .qj-sheet-panel / .qj-sheet-tabs / .qj-sheet-tab / .qj-sheet-body">
            <div className="uk-portal" style={{ height: 320 }}>
              <div className="qj-sheet qj-open" style={{ position: "absolute", inset: 0 }}>
                <div className="qj-sheet-backdrop" />
                <div className="qj-sheet-panel">
                  <div className="qj-sheet-nav">
                    <div className="qj-sheet-title">设置</div>
                    <button className="qj-sheet-close" aria-label="关闭">×</button>
                  </div>
                  <div className="qj-sheet-tabs">
                    <button className="qj-sheet-tab qj-active">模型</button>
                    <button className="qj-sheet-tab">技能</button>
                    <button className="qj-sheet-tab">快捷键</button>
                  </div>
                  <div className="qj-sheet-body">
                    <div className="qj-sheet-content">
                      <div className="qj-sheet-ink-stage" />
                      <p style={{ fontSize: 13, color: "var(--ink-2)" }}>模型:deepseek-v4-flash · 密钥:已配置</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Group>
          <Group title="首页季节植物(条件渲染)" code=".qj-stage-moment-plant / .qj-plant-body(-top/-bottom) / .qj-plant-flip">
            <div className="uk-row">
              <div className="qj-stage-moment-plant" style={{ position: "relative", width: 60, height: 120 }}>
                <div className="qj-plant-body qj-plant-body-bottom" style={{ position: "absolute", bottom: 0, left: 26, width: 3, height: 80, background: "#5c6b3a" }} />
                <div className="qj-plant-body qj-plant-body-top qj-plant-flip" style={{ position: "absolute", bottom: 60, left: 18, width: 20, height: 40, background: "rgba(92,107,58,.6)", borderRadius: "60% 0 60% 0" }} />
              </div>
              <span className="uk-cap">植物茎叶簇按日期种子条件挂载,强触发核验为现役条件件。</span>
            </div>
          </Group>
        </Section>

        {/* 38. 任务/勾选 —— 旧计划指示器已删除,墓碑节 */}
        <Section idx="38" zh="任务 · 勾选(旧计划指示器已删除)" en="Task — legacy removed" id="task">
          <p className="uk-cap uk-lead">
            墓碑:ui-kit 的旧计划步骤指示器已于 0704 删除,
            产品侧零渲染。<b>注意区分</b>:文档内 <code>taskItem/taskList</code> 勾选列表块仍现役
            (走 <code>.wf-doc</code> 内联样式 + 审核态 <code>.wf-task-cb-change</code>),与本死件无关、未动。
          </p>
        </Section>

        {/* 39. 死件档案(CSS 快照 · .cd-scope 隔离,产品删了本页不破) */}
        <Section idx="39" zh="死件档案" en="Dead archive (CSS snapshot)" id="dead">
          <p className="uk-cap uk-lead">
            清洗专项(wt/style-cleanup)已删/待删的簇。用 <b>CSS 快照法</b>:规则拷进本页
            <code>uikit-archive.css</code> 并收进 <code>.cd-scope</code> 命名空间——产品源码删掉后本页仍能存档展示,不破。
            这些类<b>不在 460 现役清单内</b>,仅作历史存档,<b>不是 Kit 规范内容</b>。
          </p>
          <div className="cd-scope uk-archive">
            <div className="uk-archive-ribbon">清洗档案 · 非 Kit 内容 · 产品代码已删/待删 · CSS 快照隔离(.cd-scope)</div>
            <Group title="接入凭据弹层 ws-cred-*(待删)" code=".ws-cred-modal / .ws-cred-field / … · 已被单机 BYO 取代">
              <div className="uk-portal" style={{ height: 300 }}>
                <div className="ws-cred-overlay">
                  <div className="ws-cred-modal">
                    <div className="ws-cred-head">
                      <span className="ws-cred-title">接入飞书</span>
                      <span className="ws-cred-badge">已废</span>
                    </div>
                    <div className="ws-cred-platform">平台:飞书开放平台</div>
                    <div className="ws-cred-intro">填入 App ID / Secret 以授权导出。此弹层已被"用户自建应用 + 单机凭据"取代。</div>
                    <div className="ws-cred-field">
                      <label className="ws-cred-label">App ID</label>
                      <input className="ws-cred-input" defaultValue="cli_xxxxxxxx" readOnly />
                      <div className="ws-cred-help">在开放平台「凭证与基础信息」获取</div>
                    </div>
                    <div className="ws-cred-actions">
                      <span className="ws-cred-saved">已保存</span>
                      <button className="wf-btn">取消</button>
                      <button className="wf-btn primary">保存</button>
                    </div>
                  </div>
                </div>
              </div>
            </Group>
            <Group title="3D 立方体 cube-face / face-*(已删 5fd902d6)" code=".cube-face / .face-front/back/left/right/top/bottom">
              <div className="cube-scene">
                <div className="cube-3d">
                  <div className="cube-face face-front">前</div>
                  <div className="cube-face face-back">后</div>
                  <div className="cube-face face-right">右</div>
                  <div className="cube-face face-left">左</div>
                  <div className="cube-face face-top">上</div>
                  <div className="cube-face face-bottom">下</div>
                </div>
              </div>
            </Group>
            <Group title="右侧抽屉 wf-drawer(已删 fd4814c4)" code=".wf-drawer.open / .wf-overlay-bg + Drawer.tsx/OverlayBg.tsx 已连根删除">
              <div className="uk-portal" style={{ height: 260 }}>
                <div className="wf-overlay-bg open" />
                <div className="wf-drawer open">
                  <div className="head">
                    <span className="title">设置(存档)</span>
                    <span aria-hidden="true">×</span>
                  </div>
                  <div className="body">此为 CSS 快照存档:生产设置面板走 overlays/settings 自有实现。</div>
                </div>
              </div>
            </Group>
          </div>
        </Section>

        {/* 40. 迁出候选(dev-only · 随工具页迁 ops 仓,不删) */}
        <Section idx="40" zh="迁出候选" en="Migration candidates (dev-only)" id="migrate">
          <p className="uk-cap uk-lead">
            dev-only 类簇的口径(用户拍板):<b>不删,随 dev 工具页整体迁往 ops 仓</b>。
            它们只在 #/uikit、#/spec、#/gallery、#/debug 这些开发者页面出现,不进生产用户界面。
          </p>
          <div className="uk-migrate">
            {MIGRATE.map(([fam, desc]) => (
              <div className="uk-migrate-card" key={fam}>
                <b>{fam}</b>
                <span>{desc}</span>
              </div>
            ))}
          </div>
        </Section>

        <div className="dig-scope">
          {/* 40.1 未收录挖掘 · 疑似死件(待裁定) */}
          <Section idx="40.1" zh="未收录挖掘 · 疑似死件(待裁定)" en="Uncollected dig — suspected dead" id="dig-dead">
            <div className="dig-ribbon">
              未收录挖掘区 · 全部待用户拍板 · 非 Kit 现役规范 · 红=疑似死件建议删 / 黄=现役未收录待收编
            </div>
            <p className="uk-cap uk-lead">
              数据源 <code>uikit-remap/map-uncollected.md</code>。本节把补集里 96 个疑似死件按 26 族做
              <b>隔离 CSS 快照</b>:生产同名类只在 <code>.dig-scope</code> 内复原观感,用于拍板删除,不回流为规范。
            </p>
            <div className="dig-stats">
              <div className="dig-stat"><b>0</b><span>待处理死件类</span></div>
              <div className="dig-stat"><b>0</b><span>待处理族记录</span></div>
              <div className="dig-stat dig-stat--red"><b>清</b><span>批次 C 已处理</span></div>
            </div>
          </Section>

          {/* 40.2 未收录挖掘 · 库存变体 */}
          <Section idx="40.2" zh="未收录挖掘 · 库存变体" en="Uncollected dig — stock variants" id="dig-stock">
            <p className="uk-cap uk-lead">
              ui-kit 库存但生产无消费的旧样本已在批次 C 清除。本节保留批次位置,不再活渲染死类。
            </p>
          </Section>

          {/* 40.3 未收录挖掘 · dev-only 资产 */}
          <Section idx="40.3" zh="未收录挖掘 · dev-only 资产" en="Uncollected dig — dev-only assets" id="dig-dev-only">
            <p className="uk-cap uk-lead">
              这批不是生产死件,多依赖 #/gallery/#/debug/#/spec 或调参入口。先族卡片披露全集,只挑能干净独立的 3 个小样活渲染。
            </p>
            <div className="dig-dev-grid">
              {DIG_DEV_ONLY.map(([family, count, route, advice]) => (
                <div className="dig-dev-card" key={family}>
                  <b>{family}</b>
                  <span>{count} 类 · {route}</span>
                  <em>{advice}</em>
                </div>
              ))}
            </div>
            <Group title="gallery gx-* 缩影" code="gallery.css · dev-only · 路由 #/gallery">
              <div className="gx-scope gx-view">
                <div className="gx-title">SVG/Result 画廊</div>
                <div className="gx-note">gx-* 只服务开发画廊,不进用户界面。</div>
                <div className="gx-table">
                  <div className="gx-stream-head"><span className="gx-col-no">#</span><span className="gx-col-state">state</span><span className="gx-col-render">render</span></div>
                  <div className="gx-group-row"><span className="gx-ministate">ok</span><span className="gx-render">可渲染</span><button className="gx-copybtn" type="button">copy</button></div>
                </div>
              </div>
            </Group>
            <Group title="debug dbg-* 缩影" code="debug.css · dev-only · 路由 #/debug">
              <div className="debug-page">
                <div className="dbg-head"><span className="dbg-title">Debug trace</span><button className="dbg-back" type="button">back</button></div>
                <div className="dbg-list">
                  <div className="dbg-item"><span className="dbg-name">session</span><span className="dbg-meta">42 events</span><button className="dbg-btn" type="button">open</button></div>
                  <pre className="dbg-raw">{"{ stream: 'truncated' }"}</pre>
                </div>
              </div>
            </Group>
            <Group title="workspace tuning panel 缩影" code="ptp-* / mdp-* · dev-only 调参器">
              <div className="presentation-tuning-panel">
                <div className="ptp-header"><span className="ptp-title">Presentation tuning</span><button className="ptp-collapse" type="button">折叠</button></div>
                <div className="ptp-body">
                  <label className="ptp-field"><span className="ptp-field-head">duration</span><input type="range" defaultValue={60} /></label>
                  <div className="ptp-actions"><button className="ptp-reset" type="button">reset</button><button className="ptp-replay" type="button">replay</button></div>
                </div>
              </div>
            </Group>
          </Section>

          {/* 40.4 未收录挖掘 · 现役未收录清单 */}
          <Section idx="40.4" zh="未收录挖掘 · 现役未收录清单" en="Uncollected dig — live but not cataloged" id="dig-active">
            <p className="uk-cap uk-lead">
              506 类不是本区删除主目标,且含大量裸 token/业务枚举噪声。这里按族披露收编候选,不做 506 项活渲染。
            </p>
            <Group title="收编候选(真组件族)" code="现役但未收录 · 建议=收编四域或显式豁免">
              <div className="dig-table-wrap">
                <table className="dig-table">
                  <thead><tr><th>族名</th><th>类数</th><th>代表 file:line</th><th>静态判定</th><th>建议</th></tr></thead>
                  <tbody>
                    {DIG_ACTIVE_CANDIDATES.map(([family, count, evidence, status, advice]) => (
                      <tr key={family}><td>{family}</td><td>{count}</td><td>{evidence}</td><td>{status}</td><td>{advice}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Group>
            <Group title="噪声 · 裸 token / 业务枚举 / 纯状态修饰" code="非独立组件,勿当漏网">
              <div className="dig-noise">
                <b>解析副产物:</b>
                <code>caret cur danger dashed done dot drafting hint icon item k lg mid mono no ok open pdf png red solid square subtle thick v wide x feishu yuque is-* row-add row-del</code>
                <span>这些多为裸修饰、工具类、导出格式枚举或条件状态,不是可独立陈列的 DOM 组件。</span>
              </div>
            </Group>
          </Section>
        </div>

        {/* 41. 覆盖率校验(双向 · 活数据 · 脚本可重跑) */}
        <Section idx="41" zh="覆盖率校验(双向)" en="Coverage audit — bidirectional" id="coverage">
          <p className="uk-cap uk-lead">
            即验收,双向:<b>正向</b>——census 采集的 <b>{coverageResult.forward.total}</b> 个现役类逐个归属
            (attributed 活渲染 / exempt 豁免带原因),零静默漏;<b>反向</b>(返工铁律)——本页手搭 DOM 的
            <b>{coverageResult.reverse.scannedTokens}</b> 个类 token 逐个审计,必须 ∈ census 现役 / import 生产组件 /
            页面骨架 / 档案快照 / dig 挖掘区 / 条件现役白名单(带 file:line 证据),违例必须为 0。
            休眠类(皮肤隐藏 / 入口停摆)单列登记,不作活渲染豁免。
            结果由 <code>scripts/verify-coverage.mjs</code> 生成,下表读 coverageResult.json,可重跑。
          </p>
          <div className="uk-cov-tiles">
            <div className="uk-cov-tile"><b>{coverageResult.forward.attributed}</b><span>正向·归属</span></div>
            <div className="uk-cov-tile"><b>{coverageResult.forward.exempt}</b><span>正向·豁免</span></div>
            <div className={`uk-cov-tile${coverageResult.forward.missing > 0 ? " uk-cov-miss" : " uk-cov-ok"}`}><b>{coverageResult.forward.missing}</b><span>正向·漏</span></div>
            <div className="uk-cov-tile"><b>{coverageResult.reverse.scannedTokens}</b><span>反向·手搭 token</span></div>
            <div className={`uk-cov-tile${coverageResult.reverse.violations.length > 0 ? " uk-cov-miss" : " uk-cov-ok"}`}><b>{coverageResult.reverse.violations.length}</b><span>反向·违例</span></div>
            <div className="uk-cov-tile"><b>{coverageResult.reverse.dormant.length}</b><span>休眠·登记</span></div>
          </div>
          <Group title="反向审计 · 违例清单" code="页面手搭 DOM → 七类合法归属,七者皆非=违例">
            {coverageResult.reverse.violations.length === 0 ? (
              <p className="uk-cap uk-lead">零违例:页面上不存在「死件/虚构类的活渲染」。分类:census {coverageResult.reverse.categories.census} · 页面自有CSS {coverageResult.reverse.categories.pageCss} · 脚手架 {coverageResult.reverse.categories.scaffold} · dig区 {coverageResult.reverse.categories.dig} · 条件现役 {coverageResult.reverse.categories.conditionalLive} · 编辑器域 {coverageResult.reverse.categories.editorPm} · 修饰 {coverageResult.reverse.categories.modifier}。</p>
            ) : (
              <ul>
                {coverageResult.reverse.violations.map((v) => (
                  <li key={v} style={{ color: "#a3352b", fontFamily: "var(--font-mono)" }}>{v}</li>
                ))}
              </ul>
            )}
          </Group>
          <Group title="反向审计 · 条件现役白名单(每条带生产渲染点证据)" code="CONDITIONAL_LIVE · census 采不到但生产有 file:line">
            <div className="uk-cov-table-wrap" style={{ maxHeight: 260 }}>
              <table className="uk-cov-table">
                <thead>
                  <tr>
                    <th>class</th>
                    <th>生产渲染点证据</th>
                  </tr>
                </thead>
                <tbody>
                  {coverageResult.reverse.conditionalLive.map((r) => (
                    <tr key={r.cls} className="uk-cov-exempt">
                      <td>{r.cls}</td>
                      <td>{r.evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Group>
          <Group title="休眠登记(皮肤隐藏 / 入口停摆 · 非活渲染豁免)" code="DORMANT · 有渲染点但用户不可达,页面只许墓碑文字引用">
            <div className="uk-cov-table-wrap" style={{ maxHeight: 200 }}>
              <table className="uk-cov-table">
                <thead><tr><th>class</th><th>休眠类型</th><th>证据</th></tr></thead>
                <tbody>
                  {(coverageResult.reverse.dormant as Array<{ cls: string; type: string; evidence: string }>).map((r) => (
                    <tr key={r.cls} className="uk-cov-miss"><td>{r.cls}</td><td>{r.type}</td><td>{r.evidence}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Group>
          <Group title="正向审计 · 460 类逐条归属" code="census → 页面">
            <div className="uk-cov-table-wrap">
              <table className="uk-cov-table">
                <thead>
                  <tr>
                    <th>class</th>
                    <th>family</th>
                    <th>状态</th>
                    <th>豁免原因</th>
                  </tr>
                </thead>
                <tbody>
                  {coverageResult.forward.rows.map((r) => (
                    <tr key={r.cls} className={`uk-cov-${r.status}`}>
                      <td>{r.cls}</td>
                      <td>{r.family}</td>
                      <td>{r.status}</td>
                      <td>{("reason" in r ? r.reason : "") as string}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Group>
        </Section>

      </div>
    </div>
  );
}

const HANDLE_DOT: CSSProperties = { width: 8, height: 8, borderRadius: "50%", background: "var(--mark)", display: "block" };

// 图表把手槽的四向定位(t/r/b/l)。
function handleSlotStyle(dir: "t" | "r" | "b" | "l"): CSSProperties {
  const base: CSSProperties = { position: "absolute", display: "flex", alignItems: "center", justifyContent: "center" };
  switch (dir) {
    case "t": return { ...base, top: -4, left: "50%", transform: "translateX(-50%)" };
    case "b": return { ...base, bottom: -4, left: "50%", transform: "translateX(-50%)" };
    case "l": return { ...base, left: -4, top: "50%", transform: "translateY(-50%)" };
    case "r": return { ...base, right: -4, top: "50%", transform: "translateY(-50%)" };
  }
}
