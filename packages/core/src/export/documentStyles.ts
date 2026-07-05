/**
 * PDF 导出用的自包含打印样式表。
 *
 * 目标:让导出的 PDF 与前端「文档纸」(.wf-doc 奶白纸暖墨皮肤)渲染出来的最终样子尽量一致。
 * 取值全部来自前端真实样式:
 *  - packages/ui-kit/src/tokens.css(设计 token)
 *  - packages/ui-kit/src/base.css / components.css(.wf-doc 基础排版)
 *  - apps/web/src/pages/workspace/workspace-ink-skin.css(#view-workspace .wf-doc 奶白纸 + 暖 token override)
 *  - apps/web/src/pages/workspace/workspace.css(callout/分栏/任务/引用/代码/行内代码/highlight 等块样式)
 *
 * 这里不直接复用前端 CSS 文件(它们大量依赖 #view-workspace / 编辑器 chrome 作用域,且夹带
 * hover/动画/浮层等屏幕态),而是把「文档纸」这一子集按相同数值重写成一份干净的打印样式,
 * 由 toHtml.ts 生成的独立 HTML 配套使用。改前端文档观感时,这份样式需要同步对齐。
 *
 * 字体:VPS / CI 通过 `fonts-noto-cjk` 安装的家族名是 "Noto Sans CJK SC" / "Noto Serif CJK SC"
 * (不是 Google Fonts 的 "Noto Sans SC"),故字体栈两者都列上,确保 headless Chromium 能命中本地字体。
 */
export const DOCUMENT_EXPORT_CSS = String.raw`
:root {
  --paper: #efe7d6;
  --ink-1: #2f2a22;
  --ink-2: #5c5346;
  --ink-3: #8a7f6e;
  --ink-4: #b3a791;
  --mark: #a8823f;
  --line-1: rgba(120, 90, 50, 0.16);
  --line-2: rgba(120, 90, 50, 0.28);
  --bg-subtle: rgba(120, 90, 50, 0.07);
  --r-sm: 4px;
  --r: 8px;
  /* workspace 水墨皮肤(workspace-ink-skin.css)把文档纸内 --font-sans/display/zh-serif 全部
     重映射成宋体衬线,所以前端文档(正文 + 标题)整体是宋体。导出对齐之:正文与标题同一套
     serif 栈;系统/CDN 命中 Noto Serif SC / Noto Serif CJK SC / 宋体。 */
  --font-sans: "Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC",
    "Songti SC", "STSong", "SimSun", "宋体", serif;
  --font-zh-serif: "Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC",
    "Songti SC", "STSong", "SimSun", "宋体", serif;
  --font-mono: "JetBrains Mono", "DejaVu Sans Mono", "Cascadia Code", ui-monospace,
    Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

/* 满铺奶白纸 + 逐页留白(两全):
   Chromium 打印不会把背景刷进 @page 外边距带(实测 html/body/fixed 背景都填不进去,恒为白)。
   所以改用 @page margin:0 让 body 奶白纸满铺整页,再用 <table> 的 thead/tfoot 间隔行——它们在
   打印时【每页重复】,给每一页顶部/底部稳定留白(内容跨页也不贴边)。这是 HTML→PDF 实现
   "整页底色 + 逐页页边距"的经典做法。结构见 toHtml.buildDocumentHtml。 */
@page {
  size: A4;
  margin: 0;
}

html,
body {
  margin: 0;
  padding: 0;
  background: var(--paper);
  -webkit-font-smoothing: antialiased;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* 分页骨架:thead/tfoot 的间隔行逐页重复 → 每页上下留白;tbody 单元格承载正文 */
table.wf-page {
  width: 100%;
  border-collapse: collapse;
  background: var(--paper);
}
.wf-page-pad {
  height: 14mm;
  padding: 0;
  border: none;
}
td.wf-page-cell {
  vertical-align: top;
  padding: 0;
  border: none;
}

.wf-doc {
  background: var(--paper);
  color: var(--ink-1);
  font-family: var(--font-sans);
  font-size: 14.5px;
  line-height: 1.85;
  /* 上下留白交给 thead/tfoot(逐页);这里水平内缩,文字不贴奶白纸左右边缘 */
  padding: 0 30px;
  max-width: 760px;
  margin: 0 auto;
}

/* ============ 标题 ============ */
.wf-doc h1,
.wf-doc h2,
.wf-doc h3,
.wf-doc h4,
.wf-doc h5,
.wf-doc h6 {
  font-weight: 600;
  break-after: avoid;
  page-break-after: avoid;
}
.wf-doc h1 {
  font-family: var(--font-zh-serif);
  font-size: 26px;
  margin: 16px 0 10px;
  letter-spacing: 0.012em;
}
.wf-doc h2 {
  font-family: var(--font-zh-serif);
  font-size: 20px;
  margin: 22px 0 8px;
  letter-spacing: 0.01em;
}
.wf-doc h3 { font-size: 17px; margin: 14px 0 4px; color: var(--ink-2); }
.wf-doc h4 { font-size: 15.5px; margin: 12px 0 4px; color: var(--ink-2); }
.wf-doc h5 { font-size: 14.8px; margin: 10px 0 4px; color: var(--ink-3); }
.wf-doc h6 { font-size: 14.5px; margin: 10px 0 4px; color: var(--ink-3); letter-spacing: 0.02em; }

.wf-doc .doc-title {
  font-family: var(--font-zh-serif);
  font-size: 30px;
  font-weight: 700;
  margin: 0 0 18px;
  letter-spacing: 0.012em;
}

/* ============ 段落 / 文字 ============ */
.wf-doc p { margin: 8px 0; }
.wf-doc strong { font-weight: 700; }
.wf-doc em { font-style: italic; }
.wf-doc a {
  color: var(--mark);
  text-decoration: underline;
  text-decoration-thickness: 0.5px;
  text-underline-offset: 2px;
}
.wf-doc mark { border-radius: 2px; padding: 0 1px; background: #fff3a3; color: inherit; }
.wf-doc mark[data-color="yellow"] { background: #fff3a3; }
.wf-doc mark[data-color="green"] { background: #d4edd4; }
.wf-doc mark[data-color="blue"] { background: #cfe0f5; }
.wf-doc mark[data-color="pink"] { background: #f5d0cf; }
.wf-doc mark[data-color="purple"] { background: #e7d7ff; }
.wf-doc code.inline-code {
  background: rgba(120, 90, 50, 0.09);
  border: 1px solid rgba(168, 130, 63, 0.22);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 0.9em;
  color: #9c5a2c;
}

/* ============ 列表 ============ */
.wf-doc ul,
.wf-doc ol { margin: 8px 0; padding-left: 24px; line-height: 1.7; }
.wf-doc ul { list-style: disc; }
.wf-doc ol { list-style: decimal; }
.wf-doc li { margin: 2px 0; }
.wf-doc li > p { margin: 2px 0; }

/* ============ 引用 ============ */
.wf-doc blockquote {
  margin: 10px 0;
  padding: 6px 14px;
  border-left: 3px solid var(--line-2);
  color: var(--ink-2);
  background: var(--bg-subtle);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  break-inside: avoid;
}
.wf-doc blockquote p { margin: 4px 0; }

/* ============ penNote(批注/落款) ============ */
.wf-doc .pm-pen-note {
  display: block;
  margin: 10px 0;
  padding: 8px 12px;
  border-left: 3px solid rgba(31, 42, 49, 0.35);
  background: rgba(31, 42, 49, 0.05);
  font-style: italic;
  color: rgba(31, 42, 49, 0.78);
}

/* ============ 分隔线 ============ */
.wf-doc hr { border: none; height: 1px; background: var(--line-2); margin: 16px 0; }

/* ============ 代码块 ============ */
.wf-doc pre.code-block {
  background: #ece1cc;
  border: 1px solid rgba(168, 130, 63, 0.22);
  border-radius: var(--r);
  padding: 14px 16px;
  margin: 14px 0;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  color: #3a322a;
  white-space: pre-wrap;
  word-break: break-word;
  break-inside: avoid;
}
.wf-doc pre.code-block code {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
}
/* 代码语法高亮(highlight.js)暖色配色,与前端 workspace.css 一致 */
.wf-doc pre.code-block .hljs-keyword,
.wf-doc pre.code-block .hljs-built_in,
.wf-doc pre.code-block .hljs-selector-tag { color: #9c5a2c; }
.wf-doc pre.code-block .hljs-string,
.wf-doc pre.code-block .hljs-title,
.wf-doc pre.code-block .hljs-section,
.wf-doc pre.code-block .hljs-attribute { color: #5a7d4a; }
.wf-doc pre.code-block .hljs-comment,
.wf-doc pre.code-block .hljs-quote { color: #8a7f6e; font-style: italic; }
.wf-doc pre.code-block .hljs-number,
.wf-doc pre.code-block .hljs-literal,
.wf-doc pre.code-block .hljs-variable,
.wf-doc pre.code-block .hljs-template-variable { color: #a8823f; }
.wf-doc pre.code-block .hljs-type,
.wf-doc pre.code-block .hljs-class,
.wf-doc pre.code-block .hljs-function,
.wf-doc pre.code-block .hljs-name { color: #7b5d94; }
.wf-doc pre.code-block .hljs-operator,
.wf-doc pre.code-block .hljs-punctuation,
.wf-doc pre.code-block .hljs-symbol,
.wf-doc pre.code-block .hljs-bullet { color: #6f665a; }
.wf-doc pre.code-block .hljs-meta,
.wf-doc pre.code-block .hljs-deletion { color: #b15059; }
.wf-doc pre.code-block .hljs-addition { color: #4f7d61; }

/* ============ 表格(对齐前端 workspace.css:1457 真实样式:完整网格线 + 暖表头) ============ */
.wf-doc table {
  border-collapse: collapse;
  width: auto;
  min-width: 240px;
  max-width: 100%;
  margin: 16px 0;
  border: 1px solid var(--line-2);
  box-shadow: inset 0 0 0 1px var(--line-2);
  font-size: 13px;
}
.wf-doc th,
.wf-doc td {
  border: 1px solid var(--line-2);
  padding: 8px 12px;
  min-width: 80px;
  vertical-align: top;
  text-align: left;
  line-height: 1.6;
}
.wf-doc th {
  background: rgba(168, 130, 63, 0.16);
  font-weight: 600;
  font-size: 12.5px;
  color: var(--ink-2);
}
/* 单元格内段落清零外边距(否则单元格偏高松散),与前端 .wf-doc td p{margin:0} 一致 */
.wf-doc td p,
.wf-doc th p { margin: 0; }
.wf-doc td img { max-width: 100%; margin: 4px 0; border-radius: var(--r-sm); }
/* 跨页时不在行内断开(整行下移),但允许大表整体跨页 */
.wf-doc tr { break-inside: avoid; }

/* ============ Callout 高亮框(10 主题暖化配色) ============ */
.wf-doc .pm-callout {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  margin: 8px 0;
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  border: 1px solid var(--line-2);
  break-inside: avoid;
}
.wf-doc .pm-callout-emoji { flex: 0 0 auto; line-height: 1.7; }
.wf-doc .pm-callout-body { flex: 1 1 auto; min-width: 0; }
.wf-doc .pm-callout-body p { margin: 0 0 4px 0; }
.wf-doc .pm-callout-body p:last-child { margin-bottom: 0; }
.wf-doc .pm-callout--neutral { background: rgba(120, 90, 50, 0.06); border-color: rgba(120, 90, 50, 0.20); }
.wf-doc .pm-callout--warning { background: rgba(168, 130, 63, 0.14); border-color: rgba(168, 130, 63, 0.34); }
.wf-doc .pm-callout--ochre { background: rgba(176, 122, 60, 0.13); border-color: rgba(176, 122, 60, 0.32); }
.wf-doc .pm-callout--danger { background: rgba(176, 74, 52, 0.10); border-color: rgba(176, 74, 52, 0.28); }
.wf-doc .pm-callout--rose { background: rgba(189, 106, 114, 0.11); border-color: rgba(189, 106, 114, 0.30); }
.wf-doc .pm-callout--mauve { background: rgba(154, 106, 158, 0.11); border-color: rgba(154, 106, 158, 0.30); }
.wf-doc .pm-callout--indigo { background: rgba(106, 108, 174, 0.10); border-color: rgba(106, 108, 174, 0.28); }
.wf-doc .pm-callout--info { background: rgba(82, 108, 150, 0.10); border-color: rgba(82, 108, 150, 0.26); }
.wf-doc .pm-callout--teal { background: rgba(79, 143, 136, 0.12); border-color: rgba(79, 143, 136, 0.30); }
.wf-doc .pm-callout--success { background: rgba(90, 125, 74, 0.12); border-color: rgba(90, 125, 74, 0.30); }

/* ============ 内容分栏 ============ */
.wf-doc .pm-column-list {
  display: flex;
  gap: 24px;
  align-items: stretch;
  margin: 12px 0;
  break-inside: avoid;
}
.wf-doc .pm-column { min-width: 0; flex: 1 1 0; }
.wf-doc .pm-column > :first-child { margin-top: 0; }
.wf-doc .pm-column > :last-child { margin-bottom: 0; }

/* ============ 任务清单 ============ */
.wf-doc ul.pm-task-list { list-style: none; margin: 8px 0; padding-left: 2px; }
.wf-doc ul.pm-task-list > li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 4px 0;
}
.wf-doc ul.pm-task-list > li > .pm-task-checkbox {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  margin-top: 5px;
  box-sizing: border-box;
  border: 1.5px solid rgba(120, 90, 50, 0.45);
  border-radius: 4px;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.wf-doc ul.pm-task-list > li.is-checked > .pm-task-checkbox {
  background: #a8823f;
  border-color: #a8823f;
}
.wf-doc ul.pm-task-list > li.is-checked > .pm-task-checkbox::after {
  content: "";
  width: 4px;
  height: 8px;
  margin-top: -1px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.wf-doc ul.pm-task-list > li > .pm-task-body { flex: 1 1 auto; min-width: 0; }
.wf-doc ul.pm-task-list > li > .pm-task-body p { margin: 0; }
.wf-doc ul.pm-task-list > li.is-checked > .pm-task-body {
  color: var(--ink-3);
  text-decoration: line-through;
  text-decoration-color: var(--line-2);
}

/* ============ 图表(mermaid SVG) ============ */
.wf-doc .pm-diagram {
  margin: 14px 0;
  text-align: center;
  break-inside: avoid;
}
.wf-doc .pm-diagram svg {
  max-width: 100%;
  height: auto;
}

/* ============ 图片 ============ */
.wf-doc figure.doc-image { margin: 14px 0; text-align: center; break-inside: avoid; }
.wf-doc figure.doc-image img { max-width: 100%; height: auto; border-radius: var(--r-sm); }
.wf-doc figure.doc-image.align-left { text-align: left; }
.wf-doc figure.doc-image.align-right { text-align: right; }
.wf-doc figure.doc-image figcaption {
  margin-top: 6px;
  font-size: 12px;
  color: var(--ink-3);
  font-style: italic;
}

/* ============ 文件附件 ============ */
.wf-doc .doc-file-attach {
  display: inline-block;
  margin: 8px 0;
  padding: 8px 12px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  color: var(--ink-2);
  font-size: 13px;
}

/* ============ 公式(KaTeX 渲染;渲染失败时回退为下方等宽源码样式) ============ */
.wf-doc .block-math {
  margin: 14px 0;
  text-align: center;
  color: var(--ink-1);
  break-inside: avoid;
}
.wf-doc .block-math .katex-display { margin: 0; }
.wf-doc .inline-math { color: inherit; }
/* KaTeX 在奶白纸上的字色对齐暖墨正文 */
.wf-doc .katex { color: var(--ink-1); font-size: 1.05em; }
`;
