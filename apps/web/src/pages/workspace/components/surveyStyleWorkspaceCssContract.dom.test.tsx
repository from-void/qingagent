import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
const inkSkinCss = readFileSync(resolve(process.cwd(), "src/pages/workspace/workspace-ink-skin.css"), "utf8");
const workspaceCss = readFileSync(resolve(process.cwd(), "src/pages/workspace/workspace.css"), "utf8");

describe("survey style workspaceCssContract", () => {
  it("在 WebKit 引擎恢复自定义细滚动条，同时保留 Firefox 标准属性", () => {
    expect(appCss).toMatch(
      /\*\s*\{[\s\S]*?scrollbar-width:\s*thin;[\s\S]*?scrollbar-color:\s*var\(--line-2\) transparent;[\s\S]*?\}/,
    );
    expect(appCss).toMatch(
      /@supports selector\(::-webkit-scrollbar-thumb\)\s*\{[\s\S]*?scrollbar-width:\s*auto !important;[\s\S]*?scrollbar-color:\s*auto !important;[\s\S]*?\}/,
    );
  });

  it("左侧对话栏保留 outset 并稳定预留滚动条槽", () => {
    expect(inkSkinCss).toMatch(
      /#view-workspace \.ws-chat\s*\{[\s\S]*?width:\s*calc\(100% \+ var\(--ws-chat-scrollbar-outset\)\);[\s\S]*?margin-right:\s*calc\(var\(--ws-chat-scrollbar-outset\) \* -1\);[\s\S]*?scrollbar-gutter:\s*stable;[\s\S]*?\}/,
    );
  });

  it("回流答卷卡覆盖汇总卡的单行截断规则", () => {
    expect(inkSkinCss).toMatch(
      /\.askuser-card--answers \.askuser-card-row\s*\{[\s\S]*?align-items:\s*flex-start;[\s\S]*?\}/,
    );
    expect(inkSkinCss).toMatch(
      /\.askuser-card--answers \.askuser-card-a\s*\{[\s\S]*?white-space:\s*normal;[\s\S]*?overflow:\s*visible;[\s\S]*?text-overflow:\s*clip;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?text-align:\s*right;[\s\S]*?\}/,
    );
  });

  it("纸底预览控件用深墨色，问卷正文与底部输入各自留在视口预算内", () => {
    expect(inkSkinCss).toMatch(/\.askuser-overlay \.auq-preview-fullscreen\s*\{[^}]*color:\s*#6b5836/s);
    expect(workspaceCss).toMatch(/\.askuser-overlay\s*\{[^}]*max-height:calc\(100dvh - 24px\);[^}]*overflow:hidden/s);
    expect(workspaceCss).toMatch(/\.au-body-scroll\{[^}]*flex:1 1 auto;[^}]*overflow:hidden/s);
    expect(workspaceCss).toMatch(/\.auq-other-wrap\{[^}]*flex:0 0 auto;[^}]*padding:8px 15px 0/s);
  });
});
