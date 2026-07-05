#!/usr/bin/env node
// UI Kit 活页覆盖率校验(零依赖,node builtins only)—— 双向。
//
// 正向(census → 页面):census 460 现役类逐个归属——
//   ① attributed:该类在「本页 DOM」或「本页真实渲染的生产组件源码」里出现;
//   ② exempt:命中豁免规则(整页场景 / 第三方 / 纯状态修饰 …),且写明原因;
//   否则 ③ missing —— 校验失败。
//
// 反向(页面 → census,返工铁律):本页「手搭 DOM」用到的每一个类 token 必须满足其一——
//   ① ∈ census 现役(attributed)
//   ② 本页自有 CSS 定义(uikit.css / uikit-archive.css / uikit-dig.css:uk-* 脚手架、qa-toast 定稿、.cd-scope 档案快照)
//   ③ 展厅脚手架前缀(uk-/cd-)
//   ④ CONDITIONAL_LIVE 白名单:现役但条件出现(hover/选中/形状变体),census 采不到,
//      每条必须带生产渲染点证据(file:line)
//   ⑤ 编辑器域(pm-*/ProseMirror*):census 采集把它们归 prosemirror 组、刻意不进 app 460,
//      但均为现役编辑器 chrome
//   ⑥ MODIFIERS:依附于同一 className 字面量里合法基类的裸修饰 token(primary/small/on …)
//   ⑦ .dig-scope 未收录挖掘区:待用户拍板的 CSS 快照/墓碑陈列,只要不出 dig-scope 即豁免。
//   休眠类(DORMANT)不属于六类合法归属,页面活渲染休眠类=违例。
//   七者皆非 → violation,校验失败。import 的生产组件渲染的类不经此审(其本身即合法引用)。
//
// 用法:node verify-coverage.mjs [--json]
//   --json:写 ../coverageResult.json(页尾活数据表读它)。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uikitDir = resolve(__dirname, "..");
const webSrc = resolve(uikitDir, "../..");

const fixture = JSON.parse(readFileSync(resolve(uikitDir, "censusFixture.json"), "utf8"));
const allClasses = Object.keys(fixture.classes).sort();

// —— 本页自有文件 + 本页真实渲染的生产组件(只列「页面确实 render 的」)——
const PAGE_FILES = [
  "pages/uikit/UIKitPage.tsx",
  "pages/uikit/uikitMocks.ts",
  "pages/uikit/uikit.css",
  "pages/uikit/uikit-archive.css",
  "pages/uikit/uikit-dig.css",
];
const RENDERED_COMPONENT_FILES = [
  // 对话流 / 工具卡 / 折叠(gallery revamp 真组件)
  "pages/gallery/revampUi.tsx",
  // 生产对话分发与各 part 渲染(user 气泡走 InkBubble 包 wf-msg.user)
  "pages/workspace/components/ChatMessageList.tsx",
  "pages/workspace/components/ReviewOutcomeCard.tsx",
  "pages/workspace/components/BrowserViewPart.tsx",
  // 图表块
  "pages/workspace/components/diagram/DiagramRenderer.tsx",
  "pages/workspace/components/diagram/GraphDiagramView.tsx",
  "pages/workspace/components/MermaidPreview.tsx",
  // AskUser 开场问卷
  "pages/workspace/components/BigPlanPanel.tsx",
  "pages/workspace/components/SliderQuestionInput.tsx",
  // 审批条 / 整篇审条 / 泼墨气泡 / 已关联文件 / 技能菜单 / 长文本 chip
  "pages/workspace/components/PatchNav.tsx",
  "pages/workspace/components/WholeDocReviewNav.tsx",
  "system/InkBubble.tsx",
  "pages/workspace/components/LinkedFilesPanel.tsx",
  "pages/workspace/components/AssetPanel.tsx",
  "system/SkillMenu.tsx",
  "system/longText.tsx",
  // 现役唯一模态(§12 真组件收录)
  "system/AuthTokenGate.tsx",
  "../../../packages/ui-kit/src/Modal.tsx",
];

function readRel(rel) {
  const p = resolve(webSrc, rel);
  if (!existsSync(p)) {
    console.warn(`[warn] scan file missing: ${rel}`);
    return "";
  }
  return readFileSync(p, "utf8");
}

const scanText = [...PAGE_FILES, ...RENDERED_COMPONENT_FILES].map(readRel).join("\n");

// token 边界:CSS class 允许 [A-Za-z0-9_-];两侧不能再接这些字符。
function hasToken(text, cls) {
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_-]|$)`);
  return re.test(text);
}

// ════════════════════════ 正向:census → 页面 ════════════════════════

// 第三层真实活渲染的 qj 条件件(季节植物 + 设置面板),不走整页豁免。
const RENDERED_QJ = new Set([
  "qj-sheet","qj-sheet-backdrop","qj-sheet-body","qj-sheet-close","qj-sheet-content","qj-sheet-nav","qj-sheet-panel","qj-sheet-tab","qj-sheet-tabs","qj-sheet-title","qj-sheet-ink-stage",
  "qj-stage-moment-plant","qj-plant-body","qj-plant-body-top","qj-plant-body-bottom","qj-plant-flip",
  "qj-open","qj-active",
]);

// —— 豁免规则:命中即豁免,必须带原因。整页场景类不是「控件」,归属于其页面本身。——
const EXEMPTIONS = [
  { test: (c) => c.startsWith("qj-") && !RENDERED_QJ.has(c), reason: "整页场景类·首页青简卷轴构图(非可复用控件);其可复用件[qj-sheet设置面板/季节植物]已在第三层活渲染" },
  { test: (c) => c.startsWith("ccx-"), reason: "整页场景类·新建页(青简门板/汉字水墨),整页构图非控件;技能chip/输入原子已在第一层覆盖" },
  { test: (c) => c.startsWith("md-"), reason: "整页场景类·模型用量仪表盘(设置内页),数据面板非通用控件" },
  { test: (c) => c.startsWith("sm-"), reason: "整页场景类·设置-模型/密钥配置页,表单排布归属其页面" },
  { test: (c) => c.startsWith("sk-"), reason: "整页场景类·新建页技能卡网格(skill card grid),归属新建页构图" },
  { test: (c) => c.startsWith("dt-"), reason: "文档顶栏(doc-topbar)内部件,归属工作区文档区页面构图" },
  { test: (c) => c.startsWith("sc-"), reason: "快捷键面板(shortcuts)整块,归属设置页" },
  { test: (c) => c.startsWith("qt-"), reason: "首页题字/引文装饰(quote title),装饰非控件" },
  { test: (c) => c.startsWith("hc-"), reason: "协作光标(hover cursor)装饰,当前无多人协作,归属未来场景" },
  { test: (c) => c.startsWith("native-"), reason: "沉浸式/演示模式外壳(presentation shell),整屏场景非控件" },
  { test: (c) => ["is-agent-active","is-dark","is-disabled","is-empty","is-morph-hidden","is-morph-out","is-np","is-on","is-open","is-placeholder","is-visible","active","no-ink"].includes(c), reason: "纯状态修饰类(is-*/active),依附具体控件由模板拼接,无独立视觉" },
  { test: (c) => ["web-app-shell","web-page-frame","web-page-frame--qingjian-home","web-page-frame--workspace","home-qingjian","body","head","tl","br","a","font-mono","card"].includes(c), reason: "页面外壳/布局工具类(app-shell/page-frame/结构容器),无独立控件视觉;字体族 font-mono/排版已在 Token 层演示" },
  { test: (c) => ["ws-body","ws-left","ws-right","ws-chat","ws-back-home","ws-paper-surface","ws-doc-topbar","ws-doc-btn"].includes(c), reason: "工作区整页骨架/文档顶栏(左右分栏/纸面/返回),归属工作区页面构图" },
  { test: (c) => c.startsWith("ws-colophon"), reason: "文档落款印章区(colophon),文档尾部装饰归属文档页" },
  { test: (c) => c.startsWith("ws-think"), reason: "思考流跑马灯(thinking marquee),流式态归属对话区运行时,已由 UTurnFold/thinking 覆盖语义" },
  { test: (c) => c.startsWith("ws-draft"), reason: "右栏草稿卡骨架(draft card),整块归属工作区右栏文档态" },
  { test: (c) => c.startsWith("ws-edit-lock"), reason: "编辑锁提示(审核态锁),运行时态归属工作区" },
  { test: (c) => ["qing-center","qing-ch","qing-col","qing-empty","qing-stage","qing-tag","qing-tag-inner"].includes(c), reason: "首页/空态青简装饰构图,非通用控件" },
  { test: (c) => c === "cm-card", reason: "首页 chinese-masonry 卡,首页构图" },
  { test: (c) => ["u-scope","u-bar","u-ico","u-lbl","u-meta","u-seg","u-spacer","u-procdiv","u-procdiv-lbl","u-procdiv-line","u-card-chev"].includes(c), reason: "对话统一组件内部件(.u-*),已随 UToolBar/UResearch 等真组件在第二层活渲染其外壳" },
  { test: (c) => c.startsWith("settings"), reason: "设置面板分区容器(settings-model/skills/shortcuts),归属设置页;设置面板外壳 qj-sheet 已在第三层" },
  { test: (c) => c === "doc-empty" || c === "doc-toolbar", reason: "文档区空态/工具栏骨架,归属文档页(doc-toolbar 已在17节选中工具条活渲染)" },
  { test: (c) => c.startsWith("chat-edit"), reason: "输入框可编辑体根节点(contenteditable),其内 chat-chip/loading-dots 已在第一/二层活渲染" },
  { test: (c) => ["arrowclosed", "connectableend", "connectablestart", "xyflow__viewport", "node-diagram", "react-renderer", "tiptap"].includes(c), reason: "第三方库(React Flow/xyflow · TipTap)运行时生成类,非本设计系统控件" },
  { test: (c) => ["em", "insert", "light", "inactive", "show-sb"].includes(c), reason: "富文本行内标记(em/insert)/主题-滚动条状态碎片,依附编辑器与运行时,无独立控件视觉" },
  { test: (c) => ["ai-cursor", "human-cursor-layer"].includes(c), reason: "编辑器 AI 光标 / 协作光标层,运行时装饰,当前无多人协作场景" },
  { test: (c) => ["seal-img", "sfx-blur", "sfx-seg"].includes(c), reason: "首页印章图 / 转场特效层(sfx),整页视觉装饰非控件" },
  { test: (c) => ["src-chip", "starter-edit", "workspace-tooltip"].includes(c), reason: "来源内联标签(citation 外壳已在19节活渲染)/ 新建页可编辑体 / 全局 tooltip 运行时浮层" },
];

const forwardRows = [];
let nAttr = 0, nExempt = 0, nMiss = 0;
for (const cls of allClasses) {
  if (hasToken(scanText, cls)) {
    forwardRows.push({ cls, family: fixture.classes[cls].family, status: "attributed" });
    nAttr++;
    continue;
  }
  const ex = EXEMPTIONS.find((e) => e.test(cls));
  if (ex) {
    forwardRows.push({ cls, family: fixture.classes[cls].family, status: "exempt", reason: ex.reason });
    nExempt++;
    continue;
  }
  forwardRows.push({ cls, family: fixture.classes[cls].family, status: "missing" });
  nMiss++;
}

// ════════════════════════ 反向:页面手搭 DOM → census ════════════════════════

// 手搭 DOM 只在 UIKitPage.tsx(mocks 无 className;CSS 不产生 DOM)。
const pageTsx = readRel("pages/uikit/UIKitPage.tsx");

// 提取 className 字面量:className="..." 与 className={`...`}(剥掉 ${...} 表达式)。
function extractClassLiterals(src) {
  const out = [];
  for (const m of src.matchAll(/className="([^"]*)"/g)) out.push(m[1]);
  // 模板字面量:含 ${expr} 的整个 token 一并丢弃(半截前缀如 `graph-diagram-node--${shape}`
  // 不是完整类名,由 CONDITIONAL_LIVE 的显式字面量样本负责审计)。
  for (const m of src.matchAll(/className=\{`([^`]*)`/g)) out.push(m[1].replace(/\S*\$\{[^}]*\}\S*/g, " "));
  return out;
}

function extractClassOccurrences(src) {
  const out = [];
  const scopeStack = [];
  let pos = 0;

  while (pos < src.length) {
    const lt = src.indexOf("<", pos);
    if (lt === -1) break;
    const next = src[lt + 1];
    if (!next || !/[A-Za-z/]/.test(next)) {
      pos = lt + 1;
      continue;
    }

    let quote = null;
    let braceDepth = 0;
    let end = lt + 1;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (quote) {
        if (ch === "\\") {
          end++;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "{") {
        braceDepth++;
        continue;
      }
      if (ch === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
        continue;
      }
      if (ch === ">" && braceDepth === 0) break;
    }
    if (end >= src.length) break;

    const tag = src.slice(lt + 1, end).trim();
    pos = end + 1;
    if (!tag || tag.startsWith("!") || tag.startsWith("?")) continue;
    if (tag.startsWith("/")) {
      scopeStack.pop();
      continue;
    }

    const parentScope = scopeStack[scopeStack.length - 1] ?? { cd: false, dig: false };
    const tokens = [];
    for (const lit of extractClassLiterals(tag)) for (const t of lit.split(/\s+/)) if (t) tokens.push(t);
    const scope = {
      cd: parentScope.cd || tokens.includes("cd-scope"),
      dig: parentScope.dig || tokens.includes("dig-scope"),
    };
    for (const token of tokens) out.push({ token, inCdScope: scope.cd, inDigScope: scope.dig });

    if (!/\/\s*$/.test(tag)) scopeStack.push(scope);
  }

  return out;
}

const tokenMeta = new Map();
for (const { token, inCdScope, inDigScope } of extractClassOccurrences(pageTsx)) {
  const meta = tokenMeta.get(token) ?? { inCdScope: 0, outOfCdScope: 0, inDigScope: 0, outOfDigScope: 0 };
  if (inCdScope) meta.inCdScope++;
  else meta.outOfCdScope++;
  if (inDigScope) meta.inDigScope++;
  else meta.outOfDigScope++;
  tokenMeta.set(token, meta);
}
const usedTokens = new Set(tokenMeta.keys());

// ② 本页自有 CSS 定义的类(uk-* 脚手架 / qa-toast 定稿 / .cd-scope 档案快照及其内部类)
const uikitCssText = readRel("pages/uikit/uikit.css");
const archiveCssText = readRel("pages/uikit/uikit-archive.css");
const digCssText = readRel("pages/uikit/uikit-dig.css");
const pageCssText = `${uikitCssText}\n${archiveCssText}\n${digCssText}`;
const pageCssClasses = new Set();
for (const m of pageCssText.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) pageCssClasses.add(m[1]);

function extractScopedClasses(css, scopeClass) {
  const out = new Set();
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of cssNoComments.matchAll(/([^{}]+)\{/g)) {
    const selector = m[1];
    if (!new RegExp(`\\.${scopeClass}\\b`).test(selector)) continue;
    for (const c of selector.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
      if (c[1] !== scopeClass) out.add(c[1]);
    }
  }
  return out;
}
const archiveScopedClasses = extractScopedClasses(archiveCssText, "cd-scope");
const digScopedClasses = extractScopedClasses(digCssText, "dig-scope");

const SPEC_FORWARD_REASON = "统一 qa-toast 现役生产家族,ToastProvider 单一通道";
const SPEC_FORWARD = {
  "qa-toast": SPEC_FORWARD_REASON,
  "qa-toast-msg": SPEC_FORWARD_REASON,
  "qa-toast-act": SPEC_FORWARD_REASON,
  "qa-toast-x": SPEC_FORWARD_REASON,
  success: SPEC_FORWARD_REASON,
  warn: SPEC_FORWARD_REASON,
  error: SPEC_FORWARD_REASON,
  sticky: SPEC_FORWARD_REASON,
  info: SPEC_FORWARD_REASON,
};

// ④ 现役·条件变体白名单:census 采不到(hover/选中/形状/快照态),但生产代码有真实渲染点。
//    每条必须带 file:line 证据 —— 新增条目前先 grep 证实。
const CONDITIONAL_LIVE = {
  // 芯片:AskUserOverlay 问卷标签 / ChatMessageList 引用 chip
  "wf-chip": "AskUserOverlay.tsx:361 · ChatMessageList.tsx:999(census 42 态未采到该出现点)",
  // 区域:审核态 patch 条带
  "wf-region": "WorkspacePage.tsx:4963 PatchUnresolvableBanner · 4988 PatchUnrenderableHint(审核态可达);历史横幅变体 4779 已停摆(hash-only 无入口)",
  // 修订删除游标:审核态文档快照渲染
  "wf-sel": "DocumentSnapshotView.tsx:3736/5090(选区态 span)",
  "wf-patch-del-marker": "DocumentSnapshotView.tsx:3923",
  "patch-del-cursor": "DocumentSnapshotView.tsx:3936",
  // 已连接文件夹 hover 卡(hover 才现)
  "wf-floaty": "FolderSourceControl.tsx:424(ws-folder-popover 外壳;A2-2 待随文件入口融合退役)",
  "ws-folder-popover": "FolderSourceControl.tsx:424",
  "ws-folder-popover-head": "FolderSourceControl.tsx:425",
  "ws-folder-popover-icon": "FolderSourceControl.tsx:426",
  "ws-folder-popover-name": "FolderSourceControl.tsx:427",
  "ws-folder-popover-path": "FolderSourceControl.tsx:429",
  "ws-folder-popover-meta": "FolderSourceControl.tsx:430",
  "ws-folder-popover-divider": "FolderSourceControl.tsx:437",
  "ws-folder-popover-disconnect": "FolderSourceControl.tsx:440",
  "ws-folder-popover-hint": "FolderSourceControl.tsx:450",
  "ws-folder-popover-arrow": "FolderSourceControl.tsx:452",
  "ws-folder-dot": "FolderSourceControl.tsx:421",
  // 图表节点形状(选中/特定 Mermaid 形状才现;--rect 在 census,其余形状变体不在)
  "graph-diagram-node--circle": "GraphDiagramView.tsx:317(`graph-diagram-node--${shape}`)",
  "graph-diagram-node--diamond": "GraphDiagramView.tsx:317",
  "graph-diagram-node--hexagon": "GraphDiagramView.tsx:317",
  "graph-diagram-node--parallelogram": "GraphDiagramView.tsx:317",
  "graph-diagram-node--doublecircle": "GraphDiagramView.tsx:317",
  // 长文本 chip(粘贴长文触发)
  "chat-chip-longtext": "system/longText.tsx:40",
  // 首页域:R2 新增。右键/失败态/搜索配置徽标均为条件出现,census 42 态未采到。
  "settings-search": "SearchPanel.tsx:212",
  "ss-card": "SearchPanel.tsx:216 · settings.css:444(搜索配置卡,census 42 态未采到)",
  "ss-badge": "SearchPanel.tsx:220 · settings.css:459(配置状态徽标,census 42 态未采到)",
  "sm-other": "ModelSettingsPanel.tsx:533",
  "sm-field-input--invalid": "ModelSettingsPanel.tsx:551 · VisionPanel.tsx:225",
  "sm-field-err": "ModelSettingsPanel.tsx:441/559 · VisionPanel.tsx:233",
  "md-dot--bad": "ModelSettingsPanel.tsx:452 · modelDashboard.css:89",
  "md-dot--warn": "ModelSettingsPanel.tsx:760 · modelDashboard.css:93",
  "md-metrics--3": "ModelSettingsPanel.tsx:707 · modelDashboard.css:151",
  "sk-off": "SkillsPanel.tsx:360 · settings.css:241",
  "sk-subhead": "SkillsPanel.tsx:253 · settings.css:274",
  "sk-back": "SkillsPanel.tsx:254 · settings.css:275",
  "sk-back-arrow": "SkillsPanel.tsx:255 · settings.css:277",
  "sk-subtitle": "SkillsPanel.tsx:260 · settings.css:278",
  "qj-dock-preview": "QingjianScroll.tsx:2491 · qingjian.css:1836",
  "qj-dock-preview-card": "QingjianScroll.tsx:2495 · qingjian.css:1854",
  "qj-dock-preview-title": "QingjianScroll.tsx:2496 · qingjian.css:1868",
  "qj-dock-preview-body": "QingjianScroll.tsx:2497 · qingjian.css:1879",
  "qj-dock-preview-meta": "QingjianScroll.tsx:2499 · qingjian.css:1891",
  "home-card-menu": "HomePage.tsx:308(右键文章卡)",
  "home-card-menu-item": "HomePage.tsx:315/324",
  "home-delete-confirm-actions": "HomePage.tsx:362",
  "home-fetch-error": "HomePage.tsx:289(列表拉取失败)",
  "ws-folder-modal-danger": "HomePage.tsx:364(删除确认危险按钮)",
  // —— R3 编辑器域(选中/块工具条 · 块手柄 · 行内浮层 · 表格 · 图编辑器上下文):
  //    均为 hover/选中/进入表格/全屏编辑器才现的 fixed portal chrome,census 42 态采不到，逐条带生产渲染点。
  // 选中 / 块工具条 DocToolbar(§17)——标题/对齐下拉菜单展开态 + 原子块紧凑条
  "dt-menu": "DocToolbar.tsx:1228/1239 · workspace.css:1290(下拉菜单容器,census 未展开采到)",
  "dt-mi": "DocToolbar.tsx:1245/1263",
  "dt-mi-k": "DocToolbar.tsx:1274",
  "dt-block-ai": "DocToolbar.tsx:907(选中原子块紧凑 AI 条)",
  // 块手柄与块操作菜单 block-handle(§18)——hover 正文左侧 gutter 才现
  "block-handle-wrap": "DocumentSnapshotView.tsx:2368 · workspace.css:1404",
  "block-handle-btn": "DocumentSnapshotView.tsx:2388 · workspace.css:1414",
  "bh-chip-inner": "DocumentSnapshotView.tsx:2427",
  "bh-type": "DocumentSnapshotView.tsx:2428",
  "bh-grip": "DocumentSnapshotView.tsx:2431",
  "fold-toggle": "DocumentSnapshotView.tsx:2445",
  "fold-caret": "DocumentSnapshotView.tsx:2456",
  "block-handle-menu": "DocumentSnapshotView.tsx:2457 · workspace.css:1470",
  "bh-section-label": "DocumentSnapshotView.tsx:2459",
  "bh-grid": "DocumentSnapshotView.tsx:2460",
  "bh-grid-btn": "DocumentSnapshotView.tsx:2461",
  "bh-divider": "DocumentSnapshotView.tsx:2471",
  "block-handle-item": "DocumentSnapshotView.tsx:2480 · workspace.css:1519",
  "bh-icon": "DocumentSnapshotView.tsx:2481",
  "bh-submenu": "DocumentSnapshotView.tsx:2476",
  "bh-submenu-trigger": "DocumentSnapshotView.tsx:2480",
  "bh-caret": "DocumentSnapshotView.tsx:2483",
  "bh-submenu-panel": "DocumentSnapshotView.tsx:2485",
  "bh-inline-insert": "DocumentSnapshotView.tsx:2516(空块插入菜单)",
  // 行内浮层:链接卡 / 公式编辑(§19)——hover 链接 / 点击公式才现
  "link-hover-card": "DocumentSnapshotView.tsx:2753 · workspace.css:1999",
  "lhc-view": "DocumentSnapshotView.tsx:2785",
  "lhc-edit": "DocumentSnapshotView.tsx:2764",
  "lhc-url": "DocumentSnapshotView.tsx:2786",
  "lhc-sep": "DocumentSnapshotView.tsx:2789",
  "lhc-btn": "DocumentSnapshotView.tsx:2780/2792",
  "lhc-input": "DocumentSnapshotView.tsx:2766",
  "math-edit-popover": "MathEditPopover.tsx:78 · workspace.css:1969",
  "math-edit-preview": "MathEditPopover.tsx:94",
  "math-edit-actions": "MathEditPopover.tsx:100",
  // 表格编辑件(§20)——光标入表 / 选列行才现
  "tbl-col-hdr": "DocumentSnapshotView.tsx:3020 · workspace.css:2029",
  "tbl-row-hdr": "DocumentSnapshotView.tsx:3028",
  "tbl-dot": "DocumentSnapshotView.tsx:3035/3044 · workspace.css:2048",
  "tbl-dot-col": "DocumentSnapshotView.tsx:3035",
  "tbl-dot-row": "DocumentSnapshotView.tsx:3044",
  "tbl-dot-mark": "DocumentSnapshotView.tsx:3038/3047",
  "tbl-sel-toolbar": "DocumentSnapshotView.tsx:3068 · workspace.css:2083",
  "tbl-color-group": "DocumentSnapshotView.tsx:3074",
  "dt-text-bar": "DocumentSnapshotView.tsx:3078 · workspace.css:1366",
  "dt-cell-fill-icon": "DocumentSnapshotView.tsx:3097 · workspace.css:1370",
  // 图表块编辑件(§24)——图编辑器全屏选中节点/连线才现
  "graph-diagram-context": "GraphDiagramView.tsx:1717 · graphDiagram.css:508",
  "graph-diagram-toolbar": "GraphDiagramView.tsx:1717 · graphDiagram.css:549",
  "graph-diagram-context--node": "GraphDiagramView.tsx:1717",
  "graph-diagram-context--edge": "GraphDiagramView.tsx:1839",
  "graph-diagram-context--below": "graphDiagram.css:526",
  "graph-diagram-toolbar__row": "GraphDiagramView.tsx:1735",
  "graph-diagram-toolbar__button": "GraphDiagramView.tsx:1989 · graphDiagram.css:549",
  "graph-diagram-toolbar__value": "GraphDiagramView.tsx:1998",
  "graph-diagram-toolbar__caret": "GraphDiagramView.tsx:1999",
  "graph-diagram-context__hint": "GraphDiagramView.tsx:1728 · graphDiagram.css:530",
  "graph-diagram-popover": "GraphDiagramView.tsx:1752 · graphDiagram.css:594",
  "graph-diagram-popover--menu": "GraphDiagramView.tsx:1826",
  "graph-diagram-shape-grid": "GraphDiagramView.tsx:1753",
  "graph-diagram-shape-btn": "GraphDiagramView.tsx:1757",
  "graph-diagram-menu-item": "GraphDiagramView.tsx:2144",
  "graph-diagram-icon": "GraphDiagramView.tsx:2044",
  // —— R3 输入区:发送门禁气泡(§27)——hover / 强制态才现
  "nokey-gate": "modelKeyGate.tsx:71 · app.css:47",
  "nokey-tip": "modelKeyGate.tsx:73 · app.css:54",
  "nokey-tip-text": "modelKeyGate.tsx:74 · app.css:117",
  "nokey-tip-btn": "modelKeyGate.tsx:75 · app.css:124",
};

// 休眠类:代码有渲染点但用户不可达 —— 皮肤永久击杀 or 入口停摆。
// 不再作为页面活渲染的豁免依据:休眠类若被页面手搭 DOM 活渲染 = 违例(只许出现在墓碑文字里)。
const DORMANT = {
};

// ⑥ 裸修饰 token:依附于同一字面量里的合法基类(wf-btn primary / qa-toast sticky …)。
const MODIFIERS = new Set([
  "primary", "ghost", "small", "lg", "icon", "square", // wf-btn 家族(components.css)
  "mono", "subtle", // wf-chip.mono / subtle 为裸修饰 token;休眠 .wf-region.subtle 只许墓碑文字引用
  "open", // wf-modal.open(AuthTokenGate)
  "is-danger", "ss-ok", // 首页右键菜单危险项 / 设置搜索状态徽标
  // R3 编辑器域 / 输入区裸状态修饰(依附 doc-toolbar / block-handle-btn / nokey-gate / *-upload-overlay 等合法基类)
  "is-block", "is-chip", "is-forced", "is-error",
]);

function classifyToken(t, meta) {
  if (fixture.classes[t]) return "census";
  if (t.startsWith("uk-") || t.startsWith("cd-")) return "scaffold";
  if (pageCssClasses.has(t) && SPEC_FORWARD[t]) return "pageCss";
  if (pageCssClasses.has(t) && archiveScopedClasses.has(t) && meta.outOfCdScope === 0) return "pageCss";
  if (pageCssClasses.has(t) && (t.startsWith("uk-") || t.startsWith("cd-"))) return "pageCss";
  if (DORMANT[t]) return "dormant";
  if (CONDITIONAL_LIVE[t]) return "conditionalLive";
  if (/^pm-|^ProseMirror/.test(t)) return "editorPm";
  if (MODIFIERS.has(t)) return "modifier";
  if (meta.outOfDigScope === 0 && meta.inDigScope > 0 && (digScopedClasses.has(t) || t === "dig-scope" || t.startsWith("dig-"))) return "dig";
  return "violation";
}

const reverseRows = [];
const catCount = { census: 0, scaffold: 0, pageCss: 0, dig: 0, conditionalLive: 0, dormant: 0, editorPm: 0, modifier: 0, violation: 0 };
for (const t of [...usedTokens].sort()) {
  const meta = tokenMeta.get(t) ?? { inCdScope: 0, outOfCdScope: 0, inDigScope: 0, outOfDigScope: 0 };
  const cat = classifyToken(t, meta);
  catCount[cat]++;
  reverseRows.push({ token: t, category: cat, evidence: DORMANT[t]?.evidence ?? CONDITIONAL_LIVE[t] ?? SPEC_FORWARD[t] ?? null });
}
const violations = reverseRows.filter((r) => r.category === "violation").map((r) => r.token);
const dormantUsed = reverseRows.filter((r) => r.category === "dormant").map((r) => r.token);

// ════════════════════════ 输出 ════════════════════════

const result = {
  generatedAt: new Date().toISOString(),
  forward: { total: allClasses.length, attributed: nAttr, exempt: nExempt, missing: nMiss, rows: forwardRows },
  reverse: {
    scannedTokens: usedTokens.size,
    categories: catCount,
    conditionalLive: Object.entries(CONDITIONAL_LIVE).map(([cls, evidence]) => ({ cls, evidence })),
    dormant: Object.entries(DORMANT).map(([cls, d]) => ({ cls, type: d.type, evidence: d.evidence })),
    specForward: Object.entries(SPEC_FORWARD).map(([cls, reason]) => ({ cls, reason })),
    violations,
    dormantViolations: dormantUsed,
  },
};

if (process.argv.includes("--json")) {
  writeFileSync(resolve(uikitDir, "coverageResult.json"), JSON.stringify(result, null, 2));
}

console.log(`正向 census→页面 — total ${result.forward.total}: attributed ${nAttr}, exempt ${nExempt}, missing ${nMiss}`);
console.log(`反向 页面→census — 手搭 token ${usedTokens.size}: census ${catCount.census}, 页面CSS ${catCount.pageCss}, 脚手架 ${catCount.scaffold}, dig区 ${catCount.dig}, 条件现役 ${catCount.conditionalLive}, 休眠被活渲染 ${catCount.dormant}, 编辑器域 ${catCount.editorPm}, 修饰 ${catCount.modifier}, 违例 ${catCount.violation}`);
let fail = false;
if (nMiss > 0) {
  console.log("\n正向 MISSING(需渲染或豁免):");
  for (const r of forwardRows.filter((r) => r.status === "missing")) console.log(`  [${r.family}] ${r.cls}`);
  fail = true;
}
if (violations.length > 0) {
  console.log("\n反向 VIOLATIONS(死件/虚构类禁止活渲染,撤下或给证据):");
  for (const v of violations) console.log(`  ${v}`);
  fail = true;
}
if (dormantUsed.length > 0) {
  console.log("\n休眠类被活渲染(只许墓碑文字):");
  for (const v of dormantUsed) console.log(`  ${v}`);
  fail = true;
}
if (fail) process.exitCode = 1;
else console.log("✓ 双向 100%:正向零漏,反向零违例。");
