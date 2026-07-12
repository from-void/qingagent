import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import contract from "../__fixtures__/workspace-css-contract.json";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../../../../..");

describe("workspaceCssContract", () => {
  it("keeps workspace.css byte-identical during Phase 0-D2", () => {
    const filePath = path.join(repoRoot, contract.file);
    const css = readFileSync(filePath, "utf8");
    const sha256 = createHash("sha256").update(css).digest("hex");
    const lineCount = css.split("\n").length - (css.endsWith("\n") ? 1 : 0);

    expect(sha256).toBe(contract.sha256);
    expect(lineCount).toBe(contract.lineCount);
  });

  it("keeps the rank-0 workspace selectors present", () => {
    const filePath = path.join(repoRoot, contract.file);
    const css = readFileSync(filePath, "utf8");

    for (const selector of contract.selectors) {
      expect(css, `missing selector ${selector}`).toContain(selector);
    }
  });

  it("keeps current patch locator as two-shot state-colored flash", () => {
    const workspaceCss = readFileSync(path.join(repoRoot, contract.file), "utf8");

    expect(workspaceCss).toContain("@keyframes wf-patch-current-flash-green");
    expect(workspaceCss).toContain("@keyframes wf-patch-current-flash-red");
    expect(workspaceCss).toMatch(/is-current\[data-patch-state="insert"\][\s\S]*animation:wf-patch-current-flash-green \.72s ease-in-out 0s 2/);
    expect(workspaceCss).toMatch(/wf-patch-replace-wrap\.is-current\[data-patch-state="insert"\][\s\S]*animation:wf-patch-current-flash-green \.72s ease-in-out 0s 2/);
    expect(workspaceCss).toMatch(/is-current\[data-patch-state="replace"\][\s\S]*animation:wf-patch-current-flash-green \.72s ease-in-out 0s 2/);
    expect(workspaceCss).toMatch(/is-current\[data-patch-state="delete"\][\s\S]*animation:wf-patch-current-flash-red \.72s ease-in-out 0s 2/);
    expect(workspaceCss).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[\s\S]*animation:none;[\s\S]*background-color:rgba\(74, 180, 100, 0\.10\);[\s\S]*background-color:rgba\(220, 80, 70, 0\.95\);[\s\S]*\n  \}/);
    expect(workspaceCss).toMatch(/rgba\(74, 180, 100/);
    expect(workspaceCss).toMatch(/rgba\(220, 80, 70/);
  });

  it("keeps pendingReview hover targets pointer-hit-testable", () => {
    const workspaceCss = readFileSync(path.join(repoRoot, contract.file), "utf8");

    expect(workspaceCss).toMatch(
      /body\[data-content="pendingReview"\] #view-workspace \.wf-doc\s*\{\s*pointer-events:none;user-select:text;cursor:default;\s*\}/,
    );
    expect(workspaceCss).toMatch(
      /body\[data-content="pendingReview"\] #view-workspace \.wf-doc \.wf-patch-ins-wrap,\s*body\[data-content="pendingReview"\] #view-workspace \.wf-doc \.wf-patch-replace-wrap\s*\{\s*pointer-events:auto;\s*\}/,
    );
    expect(workspaceCss).toMatch(
      /body\[data-content="pendingReview"\] #view-workspace \.wf-doc \.wf-patch-del-marker\s*\{\s*pointer-events:auto;\s*\}/,
    );
  });

  it("keeps table color dropdowns wired to .open so the palette is visible (非display:none)", () => {
    // 回归 tbl-cell-color-palette-display-none(R34-c1):表格选择条的文字色/单元格底色
    // dt-group 必须随 openTableColor 加 .open class,否则 CSS .dt-menu{display:none} 永不解禁、
    // 色板挂进 DOM 却 0×0 不可见,真实用户选不到色(R33-c5 用程序化 .click() 绕显示层误判可用)。
    const snapshotView = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/components/doc/TableControls.tsx"),
      "utf8",
    );
    const workspaceCss = readFileSync(path.join(repoRoot, contract.file), "utf8");
    // 解禁规则仍在(否则 .open 也没用)
    expect(workspaceCss).toContain("#view-workspace .dt-group.open .dt-menu{display:block}");
    // 表格色板与对齐下拉共用 openTableMenu，展开态都必须加 .open。
    expect(snapshotView).toContain('tbl-color-group${openTableMenu === "text" ? " open" : ""}');
    expect(snapshotView).toContain('tbl-color-group${openTableMenu === "cell" ? " open" : ""}');
    expect(snapshotView).toContain('dt-dropdown${openTableMenu === "align" ? " open" : ""}');
  });

  it("keeps table CellSelection overlay, clipped chrome and PM resize cursor styles", () => {
    const workspaceCss = readFileSync(path.join(repoRoot, contract.file), "utf8");
    const selectedCellRule = cssRule(workspaceCss, "#view-workspace .wf-doc .selectedCell::after");

    expect(selectedCellRule).toContain("background:color-mix(in srgb,var(--mark) 18%,transparent)");
    expect(selectedCellRule).not.toMatch(/box-shadow|outline|border/);
    expect(workspaceCss).toMatch(/\.tbl-chrome-viewport\{\s*overflow:clip;pointer-events:none/);
    expect(workspaceCss).toContain("#view-workspace .wf-doc .column-resize-handle");
    expect(workspaceCss).toContain("#view-workspace .wf-doc.resize-cursor");
    expect(workspaceCss).not.toContain(".tbl-cell-sel");
  });

  it("列宽拖拽命中区与细金线视觉分离", () => {
    const workspaceCss = readFileSync(path.join(repoRoot, contract.file), "utf8");
    const handleRule = cssRule(workspaceCss, "#view-workspace .wf-doc .column-resize-handle");
    const lineRule = cssRule(workspaceCss, "#view-workspace .wf-doc .column-resize-handle::before");

    expect(handleRule).toContain("width:8px");
    expect(handleRule).toContain("background:transparent");
    expect(handleRule).toContain("pointer-events:none");
    expect(lineRule).toContain("width:1px");
    expect(lineRule).toContain("var(--mark)");
    expect(workspaceCss).toMatch(/\.column-resize-dragging \.column-resize-handle::before\{\s*background:var\(--mark\)/);
  });

  it("标题列只在每行首格为 th 时 sticky，标题行 overlay 只过编辑门", () => {
    const workspaceCss = readFileSync(path.join(repoRoot, contract.file), "utf8");
    const snapshotView = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/components/DocumentSnapshotView.tsx"),
      "utf8",
    );
    const staticView = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/components/doc/PmStaticView.tsx"),
      "utf8",
    );
    const headerOverlay = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/components/doc/TableHeaderOverlay.tsx"),
      "utf8",
    );

    expect(workspaceCss).not.toContain(":has(> table > tbody > tr > td:first-child)");
    expect(workspaceCss).toContain(".pm-table-scroll > table{overflow:visible}");
    expect(workspaceCss).toMatch(/\.wf-doc table\{\s*border-collapse:separate;border-spacing:0/);
    expect(workspaceCss).toMatch(/\.wf-doc th\{\s*background:var\(--bg-subtle\);font-weight:700/);
    expect(workspaceCss).toMatch(/\[data-sticky-col\]\{\s*position:sticky;left:0;z-index:4;/);
    expect(workspaceCss).toMatch(/\[data-sticky-col\]:not\(\[data-bg-color\]\)\{\s*background:var\(--bg-canvas\)/);
    expect(workspaceCss).toMatch(/\.table-header-overlay-content > \.table-header-overlay__table\{[\s\S]*border-collapse:separate;border-spacing:0/);
    expect(workspaceCss).toMatch(/\.table-header-overlay__table th\{[\s\S]*border-right:1px solid var\(--line-2\);border-bottom:1px solid var\(--line-2\)[\s\S]*font-weight:700/);
    expect(workspaceCss).toContain('[data-table-logical-col="0"]');
    // TipTap 表格首子元素是 colgroup,首行上边框必须锚定 thead/tbody 首个,别再退回 :first-child。
    expect(workspaceCss).toContain("table > :is(thead,tbody):first-of-type > tr:first-child > th");
    expect(workspaceCss).toContain("table > :is(thead,tbody,tfoot) > tr > :first-child:not([data-table-logical-col])");
    expect(workspaceCss).toMatch(/\.tableWrapper\[data-scrolled-x\] \[data-sticky-col\],[\s\S]*box-shadow:6px 0 8px -6px/);
    expect(workspaceCss).toMatch(/\.table-header-overlay-viewport\{[\s\S]*box-shadow:0 6px 8px -6px/);
    expect(workspaceCss).toMatch(/\.pm-hover-original table\{\s*border-collapse:separate;\s*border-spacing:0/);
    expect(workspaceCss).not.toContain(".table-header-overlay__table th > p{margin:0}");
    expect(staticView).toContain("function PmTableScroll");
    expect(snapshotView).toContain("interactiveEditable && editor ? <TableHeaderOverlay editor={editor} /> : null");
    expect(headerOverlay).toContain('className="table-header-overlay-viewport"');
    expect(headerOverlay).not.toContain('className="wf-doc table-header-overlay-viewport"');
    expect(workspaceCss).toMatch(/\.wf-doc\.table-header-overlay-content\{\s*display:contents!important;[\s\S]*padding:0!important;width:auto!important;max-width:none!important;min-height:0!important/);
    expect(workspaceCss).toMatch(/\.wf-doc\.table-header-overlay-content > \.table-header-overlay__table\{\s*margin:0;/);
  });

  it("插入圆点默认态低调透明,hover 态不透明纸底与 1px 双向指示线", () => {
    const workspaceCss = readFileSync(path.join(repoRoot, contract.file), "utf8");
    const dotRule = cssRule(workspaceCss, "#view-workspace .tbl-dot");
    const dotHoverRule = cssRule(workspaceCss, "#view-workspace .tbl-dot:hover");
    const columnGuideRule = cssRule(workspaceCss, "#view-workspace .tbl-dot-col:hover::after");
    const rowGuideRule = cssRule(workspaceCss, "#view-workspace .tbl-dot-row:hover::after");

    // 默认态不许有可见底/描边(用户五轮半反馈:一排白圈扎眼);不透明底只属于 hover 态。
    expect(dotRule).toContain("border:1px solid transparent");
    expect(dotRule).toContain("background:transparent");
    expect(dotHoverRule).toContain("background:var(--bg-paper-deep)");
    expect(columnGuideRule).toContain("width:1px");
    expect(rowGuideRule).toContain("height:1px");
  });

  it("keeps round-1 editor CSS fixes present", () => {
    const workspaceCss = readFileSync(path.join(repoRoot, contract.file), "utf8");
    const componentCss = readFileSync(path.join(repoRoot, "packages/ui-kit/src/components.css"), "utf8");

    expect(workspaceCss).toContain("#view-workspace .dt-group.flip-up .dt-menu");
    expect(workspaceCss).toContain("#view-workspace .block-handle-menu.flip-up");
    expect(workspaceCss).toContain('#view-workspace .wf-doc mark[data-color="yellow"]{background:#fff3a3}');
    expect(workspaceCss).toContain("#view-workspace .wf-doc .tableWrapper{overflow-x:auto;max-width:100%}");
    expect(workspaceCss).toContain("#view-workspace .wf-doc .code-block-node{\n    position:relative;margin:14px 0;\n  }");
    expect(workspaceCss).toContain("#view-workspace .wf-doc pre .hljs-keyword");
    expect(workspaceCss).toContain("border-radius:var(--r-sm);padding:1px 6px;cursor:pointer;");
    expect(workspaceCss).not.toContain("box-shadow:inset 0 0 0 1px var(--line-2)");
    expect(componentCss).toMatch(/\.wf-doc h3\s*\{[^}]*font-size:\s*17px/s);
    expect(componentCss).toMatch(/\.wf-doc h4\s*\{[^}]*font-size:\s*15\.5px/s);
    expect(componentCss).toMatch(/\.wf-doc h5\s*\{[^}]*font-size:\s*14\.8px/s);
    expect(componentCss).toMatch(/\.wf-doc h6\s*\{[^}]*font-size:\s*14\.5px/s);

    const body = cssFontSize(componentCss, ".wf-doc");
    const headingSizes = [1, 2, 3, 4, 5, 6].map((level) =>
      cssFontSize(componentCss, `.wf-doc h${level}`),
    );
    expect(headingSizes).toEqual([26, 20, 17, 15.5, 14.8, 14.5]);
    for (let i = 1; i < headingSizes.length; i++) {
      expect(headingSizes[i - 1]!).toBeGreaterThan(headingSizes[i]!);
    }
    for (const size of headingSizes) {
      expect(size).toBeGreaterThanOrEqual(body);
    }
  });

  it("keeps block handle submenus outside the vertical menu scrollport", () => {
    const workspaceCss = readFileSync(path.join(repoRoot, contract.file), "utf8");
    const blockHandle = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/components/doc/BlockHandle.tsx"),
      "utf8",
    );

    const menuRule = cssRule(workspaceCss, "#view-workspace .block-handle-menu");
    const panelRule = cssRule(workspaceCss, "#view-workspace .bh-submenu-panel");

    expect(menuRule).toContain("overflow-y:auto");
    expect(menuRule).not.toContain("overflow-x:hidden");
    expect(panelRule).toContain("position:fixed");
    expect(panelRule).toContain("left:var(--bh-submenu-left, -9999px)");
    expect(panelRule).toContain("top:var(--bh-submenu-top, -9999px)");
    expect(panelRule).not.toContain("position:absolute");
    expect(workspaceCss).toMatch(
      /#view-workspace \.bh-submenu\.is-left \.bh-submenu-panel,\s*#view-workspace \.bh-submenu-panel\.is-left\{/,
    );
    expect(workspaceCss).toMatch(
      /#view-workspace \.bh-submenu:hover \.bh-submenu-panel,\s*#view-workspace \.bh-submenu:focus-within \.bh-submenu-panel,\s*#view-workspace \.bh-submenu-panel\.is-open\{/,
    );
    expect(workspaceCss).not.toContain("right:calc(100% + 4px)");
    expect(blockHandle).toContain('import { createPortal } from "react-dom";');
    expect(blockHandle).toContain('editor.view.dom.closest("#view-workspace")');
    expect(blockHandle).toContain("createPortal(submenuPanels, submenuPortalTarget)");
    expect(blockHandle).toContain("bh-submenu-portal");
    expect(blockHandle).toContain('"--bh-submenu-left": `${alignPlacement.left}px`');
    expect(blockHandle).toContain('"--bh-submenu-left": `${insertPlacement.left}px`');
  });

  it("keeps bigplan options scrollable above the floating action bar", () => {
    const inkSkinCss = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/workspace-ink-skin.css"),
      "utf8",
    );

    expect(inkSkinCss).toContain("--ws-float-bar-height: 52px");
    expect(inkSkinCss).toContain("--ws-float-bar-bottom: 26px");
    expect(inkSkinCss).toContain("--ws-bigplan-bottom-safe-area");
    expect(inkSkinCss).toMatch(
      /#view-workspace \.ws-float-bar \{[^}]*bottom:\s*var\(--ws-float-bar-bottom\);[^}]*height:\s*var\(--ws-float-bar-height\)/s,
    );
    expect(inkSkinCss).toMatch(
      /#view-workspace \.bigplan-panel \.bp-body \{[^}]*padding:\s*2px 64px var\(--ws-bigplan-bottom-safe-area\) !important;[^}]*scroll-padding-bottom:\s*var\(--ws-bigplan-bottom-safe-area\)/s,
    );
    expect(inkSkinCss).toMatch(
      /#view-workspace \.bigplan-panel \.bp-opt \{[^}]*scroll-margin-bottom:\s*var\(--ws-bigplan-bottom-safe-area\)/s,
    );
  });

  it("keeps inline askUser card wired to FLIP, scroll affordances, and safe slider layout", () => {
    const workspaceController = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/hooks/useWorkspacePageController.tsx"),
      "utf8",
    );
    const askUserOverlay = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/components/AskUserOverlay.tsx"),
      "utf8",
    );
    const workspaceCss = readFileSync(path.join(repoRoot, contract.file), "utf8");
    const inkSkinCss = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/workspace-ink-skin.css"),
      "utf8",
    );

    expect(workspaceController).toContain('".ws-float-bar, .patch-nav, .askuser-overlay"');
    expect(inkSkinCss).toMatch(
      /#view-workspace \.ws-float-bar > \*,\s*#view-workspace \.patch-nav > \*,\s*#view-workspace \.askuser-overlay > \*/s,
    );
    // 滚动内阴影改为不依赖底色的 au-edge 叠层 + JS 滚动监听(面板保持透明磨砂)
    expect(workspaceCss).toMatch(
      /#view-workspace \.au-body\{[^}]*overflow-y:auto;overflow-x:hidden;[^}]*background:transparent;[^}]*scrollbar-color:transparent transparent/s,
    );
    expect(workspaceCss).toMatch(/#view-workspace \.au-edge\[data-show="true"\]\{opacity:1\}/);
    expect(workspaceCss).toMatch(
      /#view-workspace \.au-body:hover,\s*#view-workspace \.au-body:focus-within\{scrollbar-color:var\(--line-2\) transparent\}/s,
    );
    expect(inkSkinCss).toMatch(
      /#view-workspace \.askuser-overlay \.au-body:hover::-webkit-scrollbar-thumb,\s*#view-workspace \.askuser-overlay \.au-body:focus-within::-webkit-scrollbar-thumb \{[^}]*background-color:\s*rgba\(184, 169, 140, 0\.3\)/s,
    );
    expect(workspaceCss).toContain("#view-workspace .aus2-track-wrap{position:relative;height:34px;display:flex;align-items:center}");
    expect(workspaceCss).toContain("#view-workspace .aus2-input{");
    expect(workspaceCss).toContain("-webkit-appearance:none;appearance:none;width:100%;height:34px;background:transparent;");
    expect(workspaceCss).toContain("#view-workspace .aus2-bubble{");
    expect(inkSkinCss).toContain("#view-workspace .aus2-scale span[data-hit=\"true\"]");
    expect(workspaceCss).toContain("#view-workspace .askuser-portal-anchor{");
    expect(workspaceCss).toMatch(
      /#view-workspace \.askuser-overlay\[data-portal="true"\]\{[\s\S]*left:var\(--au-portal-left\);[\s\S]*bottom:var\(--au-portal-bottom\)/,
    );
    expect(askUserOverlay).toContain('document.getElementById("view-workspace")');
    expect(askUserOverlay).toContain("anchorRef.current?.getBoundingClientRect()");
  });

  it("keeps material text preview as auto-height paper scrolled by ws-right", () => {
    const workspaceCss = readFileSync(path.join(repoRoot, contract.file), "utf8");

    const previewRule = cssRule(workspaceCss, "#view-workspace .fd-right-preview");
    expect(previewRule).toContain("flex:0 0 auto");
    expect(previewRule).toContain("height:auto");

    const bodyRule = cssRule(workspaceCss, "#view-workspace .fd-rp-body");
    expect(bodyRule).toContain("flex:0 0 auto");
    expect(bodyRule).toContain("min-height:auto");
    expect(bodyRule).not.toContain("min-height:0");

    const bodyTextRule = cssRule(workspaceCss, "#view-workspace .fd-rp-body-text");
    expect(bodyTextRule).toContain("overflow:visible");
  });

  it("keeps edit lock as a body-level fixed portal instead of a ws-right flow child", () => {
    const workspaceOverlays = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/components/WorkspaceOverlays.tsx"),
      "utf8",
    );
    const inkSkinCss = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/workspace-ink-skin.css"),
      "utf8",
    );

    expect(workspaceOverlays).toContain('import { createPortal } from "react-dom";');
    expect(workspaceOverlays).toContain('data-wf="WorkspaceEditLockHint"');
    expect(workspaceOverlays).toContain("createPortal(");
    expect(workspaceOverlays).not.toContain("ws-edit-lock 必须保持为 .ws-right 的最后一个流内子级");

    const lockRule = cssRule(inkSkinCss, "body > .ws-edit-lock");
    expect(lockRule).toContain("position: fixed");
    // 水平居中于文档纸(--doc-left/--doc-right 中点),而非视口右下角
    expect(lockRule).toContain("left: calc((var(--doc-left, 0px) + var(--doc-right, 100vw)) / 2)");
    expect(lockRule).toContain("transform: translateX(-50%)");
    expect(lockRule).toContain("justify-content: center");
    expect(lockRule).toContain("bottom: max(28px, env(safe-area-inset-bottom))");
    expect(lockRule).toContain("z-index: 9999");
    expect(lockRule).toContain("pointer-events: none");
    const hintRule = cssRule(inkSkinCss, "body > .ws-edit-lock .ws-edit-lock-hint");
    expect(hintRule).toContain("position: relative");
    expect(hintRule).toContain("transform: translateY(8px)");
    expect(hintRule).not.toContain("left: 50%");
    expect(inkSkinCss).toContain(':has(#view-workspace .ws-right:hover)');
  });

  it("keeps busy glow attached to the scrolling paper surface and decoupled from review bars", () => {
    const documentSnapshotView = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/components/DocumentSnapshotView.tsx"),
      "utf8",
    );
    const inkSkinCss = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/workspace-ink-skin.css"),
      "utf8",
    );

    expect(documentSnapshotView).toContain('data-wf="WorkspaceEditorGlow"');
    const glowRule = cssStandaloneRule(inkSkinCss, "#view-workspace .ws-paper-surface > .ws-editor-glow");
    expect(glowRule).toContain("position: absolute");
    expect(glowRule).toContain("inset: 0");
    expect(glowRule).toContain("pointer-events: none");
    expect(inkSkinCss).toMatch(
      /body\[data-tool="agentBusy"\] #view-workspace \.ws-paper-surface > \.ws-editor-glow,[\s\S]*animation:\s*ws-paper-breathe 3\.6s ease-in-out infinite/s,
    );
    expect(inkSkinCss).not.toContain("#view-workspace .ws-right > .ws-editor-glow");
    expect(glowRule).not.toContain("position: fixed");
    expect(inkSkinCss).not.toContain(
      'body[data-tool="agentBusy"] #view-workspace .ws-right .ws-paper-surface::after',
    );
    expect(inkSkinCss).not.toMatch(/\.ws-colophon[^{]*\{[^}]*animation:\s*ws-paper-breathe/s);
    expect(inkSkinCss).not.toMatch(/\.patch-nav[^{]*\.ws-editor-glow/s);
    expect(inkSkinCss).not.toMatch(/\.ws-edit-lock[^{]*\.ws-editor-glow/s);
  });

  it("keeps confirmed legacy workspace CSS removed", () => {
    const workspaceCss = readFileSync(path.join(repoRoot, contract.file), "utf8");
    const inkSkinCss = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/workspace-ink-skin.css"),
      "utf8",
    );
    const css = `${workspaceCss}\n${inkSkinCss}`;

    for (const selector of [
      ".ws-topbar",
      ".ws-askuser-q",
      ".opts-row",
      ".ws-pop-item",
      ".ws-status-detail",
      ".history-nav",
      ".history-readonly",
      ".ai-edit-highlight",
      ".native-presentation-hud",
      ".native-presentation-progress",
      ".native-presentation-skip",
      "#sel-pop",
      // 0704 style-cleanup 连根删除的产品侧旧凭据表单
      ".ws-cred-overlay",
      ".ws-cred-modal",
      ".ws-cred-field",
      // 0705 删除文档大纲(DocOutline)——组件与 ws-outline/o-item 皮肤规则一并物理删除
      ".ws-outline",
      ".o-item",
    ]) {
      expect(css).not.toContain(selector);
    }
  });
});

function cssFontSize(css: string, selector: string): number {
  const match = /font-size:\s*([0-9.]+)px/.exec(cssRule(css, selector));
  if (!match) throw new Error(`font-size not found: ${selector}`);
  return Number(match[1]);
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{[^}]*\\}`, "s").exec(css);
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[0];
}

function cssStandaloneRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*\\}`, "s").exec(css);
  if (!match) throw new Error(`standalone rule not found: ${selector}`);
  return match[0];
}
