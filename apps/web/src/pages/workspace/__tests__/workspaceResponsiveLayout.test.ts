import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(testDir, "..");
const responsiveCss = readFileSync(
  path.join(workspaceDir, "workspace-responsive.css"),
  "utf8",
);
const workspacePageSource = readFileSync(
  path.join(workspaceDir, "WorkspacePage.tsx"),
  "utf8",
);

describe("workspace 窄桌面布局", () => {
  it("768–1279px 使用能完整容纳双栏的流式几何，1280px 起不覆盖既有布局", () => {
    expect(responsiveCss).toMatch(
      /@media \(min-width: 768px\) and \(max-width: 1279px\)/,
    );
    expect(responsiveCss).toContain("--ws-paper-body-padding-inline: 24px");
    expect(responsiveCss).toContain("--ws-paper-chat-column-width: 320px");
    expect(responsiveCss).toContain("--ws-paper-column-gap: 24px");
    expect(responsiveCss).toMatch(
      /--ws-paper-column-width:\s*min\(\s*800px,\s*calc\(\s*100vw\s*-\s*var\(--ws-paper-body-padding-inline\)\s*-\s*var\(--ws-paper-body-padding-inline\)\s*-\s*var\(--ws-paper-chat-column-width\)\s*-\s*var\(--ws-paper-column-gap\)\s*\)\s*\)/s,
    );
  });

  it("窄桌面只压缩纸面横向留白，并确保响应式覆盖最后加载", () => {
    expect(responsiveCss).toMatch(
      /#view-workspace \.wf-doc,\s*#view-workspace \.ws-paper-shell\s*\{[^}]*padding-right:\s*48px !important;[^}]*padding-left:\s*48px !important;/s,
    );
    expect(workspacePageSource.indexOf('import "./workspace-responsive.css";')).toBeGreaterThan(
      workspacePageSource.indexOf('import "./workspace-ink-skin.css";'),
    );
  });
});
