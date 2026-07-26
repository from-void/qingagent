import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  controller: null as Record<string, unknown> | null,
}));

vi.mock("./hooks/useWorkspacePageController", () => ({
  useWorkspacePageController: () => mocks.controller,
}));
vi.mock("./components/WorkspaceTopbar", () => ({
  WorkspaceTopbar: () => <header data-testid="topbar" />,
}));
vi.mock("./components/WorkspaceChatPane", () => ({
  WorkspaceChatPane: () => (
    <aside className="ws-left" data-testid="chat-pane">
      <div
        className="ws-chat-content"
        data-wf="WorkspaceHydrationChatContent"
      >
        <div className="ws-chat" data-testid="message-list" />
      </div>
      <div className="ws-input-wrap" data-testid="input-chrome">
        <div className="wf-input" />
      </div>
    </aside>
  ),
}));
vi.mock("./components/WorkspaceDocumentPane", () => ({
  WorkspaceDocumentPane: () => (
    <main className="ws-right" data-testid="document-pane">
      <div
        className="ws-paper-shell"
        data-wf="WorkspacePaperShell"
        aria-hidden="true"
      />
      <div
        className="ws-document-content"
        data-wf="WorkspaceHydrationDocumentContent"
      >
        <article className="wf-doc" data-testid="document-paper">
          <p data-testid="document-content">既有正文</p>
        </article>
      </div>
    </main>
  ),
}));
vi.mock("./components/WorkspaceOverlays", () => ({
  WorkspaceOverlays: () => null,
}));

import { WorkspacePage } from "./WorkspacePage";

const workspaceCss = readFileSync(
  resolve(process.cwd(), "src/pages/workspace/workspace.css"),
  "utf8",
);
const workspaceInkSkinCss = readFileSync(
  resolve(process.cwd(), "src/pages/workspace/workspace-ink-skin.css"),
  "utf8",
);

describe("WorkspacePage hydration DOM gate", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    mocks.controller = null;
  });

  function controller(phase: "waiting" | "ready") {
    return {
      viewRef: { current: null },
      dataAttrs: { content: "empty", tool: "idle" },
      hydration: { phase, timedOut: false },
    };
  }

  it("纸壳与 chrome 首帧恒在，只隐藏内容，ready 后容器不卸载重挂", async () => {
    mocks.controller = controller("waiting");
    await act(async () => root.render(<WorkspacePage />));

    const leftBeforeReady = host.querySelector(".ws-left");
    const rightBeforeReady = host.querySelector(".ws-right");
    const paperBeforeReady = host.querySelector('[data-wf="WorkspacePaperShell"]');
    const inputBeforeReady = host.querySelector('[data-testid="input-chrome"]');
    const chatContentBeforeReady = host.querySelector(
      '[data-wf="WorkspaceHydrationChatContent"]',
    );
    const docContentBeforeReady = host.querySelector(
      '[data-wf="WorkspaceHydrationDocumentContent"]',
    );
    const docBeforeReady = host.querySelector(".wf-doc");
    expect(leftBeforeReady).not.toBeNull();
    expect(rightBeforeReady).not.toBeNull();
    expect(paperBeforeReady).not.toBeNull();
    expect(inputBeforeReady).not.toBeNull();
    expect(chatContentBeforeReady).not.toBeNull();
    expect(docContentBeforeReady).not.toBeNull();
    expect(docBeforeReady).not.toBeNull();
    expect(host.querySelector(".ws-body")?.getAttribute("aria-busy")).toBe(
      "true",
    );

    mocks.controller = controller("ready");
    await act(async () => root.render(<WorkspacePage />));

    expect(host.querySelector(".ws-left")).toBe(leftBeforeReady);
    expect(host.querySelector(".ws-right")).toBe(rightBeforeReady);
    expect(host.querySelector('[data-wf="WorkspacePaperShell"]')).toBe(
      paperBeforeReady,
    );
    expect(host.querySelector('[data-testid="input-chrome"]')).toBe(
      inputBeforeReady,
    );
    expect(
      host.querySelector('[data-wf="WorkspaceHydrationChatContent"]'),
    ).toBe(chatContentBeforeReady);
    expect(
      host.querySelector('[data-wf="WorkspaceHydrationDocumentContent"]'),
    ).toBe(docContentBeforeReady);
    expect(host.querySelector(".wf-doc")).toBe(docBeforeReady);
    expect(host.querySelector(".ws-body")?.getAttribute("aria-busy")).toBe(
      "false",
    );
  });

  it("等待规则只扣消息与正文，纸壳沿用真实纸底且左右容器不参与动画", () => {
    const waitingRule = workspaceCss.match(
      /#view-workspace \.ws-body\[data-hydration="waiting"\][\s\S]*?\{[^}]*\}/,
    )?.[0];
    const paperRule = workspaceInkSkinCss.match(
      /#view-workspace \.wf-doc,\s*#view-workspace \.ws-paper-shell\s*\{[^}]*\}/,
    )?.[0];

    expect(waitingRule).toContain("visibility:hidden");
    expect(waitingRule).not.toContain("background");
    expect(waitingRule).not.toContain("var(--bg-canvas)");
    expect(waitingRule).toContain(".ws-chat-content");
    expect(waitingRule).toContain(".ws-document-content > *");
    expect(waitingRule).not.toContain("> .ws-left");
    expect(waitingRule).not.toContain("> .ws-right");
    expect(paperRule).toContain("background: var(--bg-paper-deep)");
    expect(paperRule).toContain("min-height: var(--ws-paper-min-height)");
    expect(workspaceCss).toContain(
      ".ws-right:has(.ws-document-content .wf-doc) > .ws-paper-shell",
    );
    expect(workspaceCss).toContain(
      '.ws-body[data-hydration="waiting"] .ws-document-content .wf-doc > *',
    );
    expect(workspaceCss).toContain("transition:opacity 180ms ease-out");
    expect(workspaceCss).not.toMatch(
      /\.ws-(?:left|right)\s*\{[^}]*animation:[^}]*hydration/,
    );
    expect(workspaceCss).not.toContain(".ws-hydration-canvas");
    expect(workspaceCss).not.toContain(".ws-hydration-left");
    expect(workspaceCss).not.toContain(".ws-hydration-right");
  });

  it("首页新建路径立即挂载纸壳、空白内容与对话 chrome", async () => {
    mocks.controller = controller("ready");
    await act(async () => root.render(<WorkspacePage />));

    expect(host.querySelector(".ws-left")).not.toBeNull();
    expect(host.querySelector(".ws-right")).not.toBeNull();
    expect(host.querySelector('[data-wf="WorkspacePaperShell"]')).not.toBeNull();
    expect(
      host.querySelector('[data-wf="WorkspaceHydrationDocumentContent"]'),
    ).not.toBeNull();
    expect(host.querySelector(".ws-body")?.getAttribute("aria-busy")).toBe(
      "false",
    );
  });

  it("稳态不残留 hydration 动画属性，输入框毛玻璃规则仍为非 none", async () => {
    mocks.controller = controller("ready");
    await act(async () => root.render(<WorkspacePage />));

    expect(host.querySelector(".ws-body")?.hasAttribute("data-hydration-reveal")).toBe(
      false,
    );
    expect(workspaceCss).not.toContain("ws-hydration-reveal");
    expect(workspaceCss).not.toMatch(
      /\.ws-(?:chat|document)-content[^}]*animation(?:-fill-mode)?:/s,
    );
    const inputGlassRule = workspaceInkSkinCss.match(
      /#view-workspace \.wf-input\s*\{[^}]*\}/,
    )?.[0];
    expect(inputGlassRule).toContain(
      "backdrop-filter: var(--fx-workspace-backdrop-filter)",
    );
    expect(inputGlassRule).not.toContain("backdrop-filter: none");
  });

  // 真机预期时间线：
  // arriving(waiting，纸壳/chrome 恒在) → 两个 rAF 后 arrive-revealing(waiting，
  // 仍仅空纸) → hydration ready(内容一次淡入)；ready 单调，不卸载 left/doc。
});
