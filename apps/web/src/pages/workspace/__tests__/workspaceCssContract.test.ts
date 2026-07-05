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
    // 两个表格色板 dt-group 都按 openTableColor 条件加 .open
    expect(snapshotView).toContain('tbl-color-group${openTableColor === "text" ? " open" : ""}');
    expect(snapshotView).toContain('tbl-color-group${openTableColor === "cell" ? " open" : ""}');
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
    expect(workspaceCss).toContain("box-shadow:inset 0 0 0 1px var(--line-2)");
    expect(workspaceCss).toContain("box-shadow:inset 0 0 0 1.5px var(--mark)");

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
    const workspacePage = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/WorkspacePage.tsx"),
      "utf8",
    );
    const workspaceCss = readFileSync(path.join(repoRoot, contract.file), "utf8");
    const inkSkinCss = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/workspace-ink-skin.css"),
      "utf8",
    );

    expect(workspacePage).toContain('".ws-float-bar, .patch-nav, .askuser-overlay"');
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
    expect(workspaceCss).toContain(".au-slider{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;padding:4px 8px;overflow-x:hidden}");
    expect(workspaceCss).toContain(".au-slider-input{flex:1 1 220px;min-width:0;width:100%");
    expect(workspaceCss).toContain("flex:0 0 auto;min-width:86px;max-width:100%;text-align:center;white-space:nowrap;");
  });

  it("keeps edit lock as the final flow child of ws-right", () => {
    const workspacePage = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/WorkspacePage.tsx"),
      "utf8",
    );

    expect(workspacePage).toContain("ws-edit-lock 必须保持为 .ws-right 的最后一个流内子级");
    expect(workspacePage).toMatch(
      /<DocToolbar[\s\S]*?<AssetPreview[\s\S]*?<div className="ws-edit-lock"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*\{\/\* 调试调参面板/s,
    );
  });

  it("keeps paper and colophon glow on one continuous surface", () => {
    const snapshotView = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/components/DocumentSnapshotView.tsx"),
      "utf8",
    );
    const inkSkinCss = readFileSync(
      path.join(repoRoot, "apps/web/src/pages/workspace/workspace-ink-skin.css"),
      "utf8",
    );

    expect(snapshotView.match(/className="ws-paper-surface"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(inkSkinCss).toContain("#view-workspace .ws-paper-surface::after");
    expect(inkSkinCss).toMatch(
      /body\[data-tool="agentBusy"\] #view-workspace \.ws-right \.ws-paper-surface::after,[\s\S]*animation:\s*ws-paper-breathe 3\.6s ease-in-out infinite/s,
    );
    expect(inkSkinCss).not.toMatch(/\.ws-colophon[^{]*\{[^}]*animation:\s*ws-paper-breathe/s);
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
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{[^}]*font-size:\\s*([0-9.]+)px`, "s").exec(css);
  if (!match) throw new Error(`font-size not found: ${selector}`);
  return Number(match[1]);
}
