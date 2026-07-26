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
  WorkspaceChatPane: () => <aside className="ws-left" data-testid="chat-pane" />,
}));
vi.mock("./components/WorkspaceDocumentPane", () => ({
  WorkspaceDocumentPane: () => (
    <main className="ws-right" data-testid="document-pane">
      <article className="wf-doc" />
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

  it("既有会话左右树只挂一次，等待期不可见，ready 后不卸载重挂", async () => {
    mocks.controller = controller("waiting");
    await act(async () => root.render(<WorkspacePage />));

    expect(host.querySelector('[data-wf="WorkspaceHydrationCanvas"]')).toBeNull();
    expect(host.querySelector('[data-wf="WorkspaceHydrationChat"]')).toBeNull();
    expect(host.querySelector('[data-wf="WorkspaceHydrationDocument"]')).toBeNull();
    const leftBeforeReady = host.querySelector(".ws-left");
    const rightBeforeReady = host.querySelector(".ws-right");
    const docBeforeReady = host.querySelector(".wf-doc");
    expect(leftBeforeReady).not.toBeNull();
    expect(rightBeforeReady).not.toBeNull();
    expect(docBeforeReady).not.toBeNull();
    expect(host.querySelector(".ws-body")?.getAttribute("aria-busy")).toBe(
      "true",
    );

    mocks.controller = controller("ready");
    await act(async () => root.render(<WorkspacePage />));

    expect(host.querySelector(".ws-left")).toBe(leftBeforeReady);
    expect(host.querySelector(".ws-right")).toBe(rightBeforeReady);
    expect(host.querySelector(".wf-doc")).toBe(docBeforeReady);
    expect(host.querySelector(".ws-body")?.getAttribute("aria-busy")).toBe(
      "false",
    );
  });

  it("等待规则只隐藏真实面板并透出玄青桌面，不绘制浅色占位", () => {
    const waitingRule = workspaceCss.match(
      /#view-workspace \.ws-body\[data-hydration="waiting"\][\s\S]*?\{[^}]*\}/,
    )?.[0];

    expect(waitingRule).toContain("visibility:hidden");
    expect(waitingRule).not.toContain("background");
    expect(waitingRule).not.toContain("var(--bg-canvas)");
    expect(workspaceCss).not.toContain(".ws-hydration-canvas");
    expect(workspaceCss).not.toContain(".ws-hydration-left");
    expect(workspaceCss).not.toContain(".ws-hydration-right");
  });

  it("首页新建路径立即挂载空白文档与对话列", async () => {
    mocks.controller = controller("ready");
    await act(async () => root.render(<WorkspacePage />));

    expect(host.querySelector('[data-wf="WorkspaceHydrationCanvas"]')).toBeNull();
    expect(host.querySelector(".ws-left")).not.toBeNull();
    expect(host.querySelector(".ws-right")).not.toBeNull();
  });

  it("稳态不残留 hydration 动画属性，输入框毛玻璃规则仍为非 none", async () => {
    mocks.controller = controller("ready");
    await act(async () => root.render(<WorkspacePage />));

    expect(host.querySelector(".ws-body")?.hasAttribute("data-hydration-reveal")).toBe(
      false,
    );
    expect(workspaceCss).not.toContain("ws-hydration-reveal");
    const inputGlassRule = workspaceInkSkinCss.match(
      /#view-workspace \.wf-input\s*\{[^}]*\}/,
    )?.[0];
    expect(inputGlassRule).toContain(
      "backdrop-filter: var(--fx-workspace-backdrop-filter)",
    );
    expect(inputGlassRule).not.toContain("backdrop-filter: none");
  });
});
