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
  WorkspaceDocumentPane: () => <main className="ws-right" data-testid="document-pane" />,
}));
vi.mock("./components/WorkspaceOverlays", () => ({
  WorkspaceOverlays: () => null,
}));

import { WorkspacePage } from "./WorkspacePage";

const workspaceCss = readFileSync(
  resolve(process.cwd(), "src/pages/workspace/workspace.css"),
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

  function controller(
    phase: "waiting" | "document-only" | "ready",
    revealMode: "none" | "together" | "document-then-chat" = "none",
  ) {
    return {
      viewRef: { current: null },
      dataAttrs: { content: "empty", tool: "idle" },
      hydration: { phase, revealMode, timedOut: false },
    };
  }

  it("既有会话快照未就绪前不挂载空编辑器和空对话列，完成后一次成画", async () => {
    mocks.controller = controller("waiting");
    await act(async () => root.render(<WorkspacePage />));

    expect(host.querySelector('[data-wf="WorkspaceHydrationCanvas"]')).toBeNull();
    expect(host.querySelector('[data-wf="WorkspaceHydrationChat"]')).not.toBeNull();
    expect(host.querySelector('[data-wf="WorkspaceHydrationDocument"]')).not.toBeNull();
    expect(host.querySelector(".ws-left")).toBeNull();
    expect(host.querySelector(".ws-right")).toBeNull();

    mocks.controller = controller("ready", "together");
    await act(async () => root.render(<WorkspacePage />));

    expect(host.querySelector('[data-wf="WorkspaceHydrationCanvas"]')).toBeNull();
    expect(host.querySelectorAll(".ws-left")).toHaveLength(1);
    expect(host.querySelectorAll(".ws-right")).toHaveLength(1);
  });

  it("占位层透明透出玄青桌面，禁止回退到全局浅色 canvas token", () => {
    const hydrationRules = [
      workspaceCss.match(/#view-workspace \.ws-hydration-left\{[^}]*\}/)?.[0],
      workspaceCss.match(/#view-workspace \.ws-hydration-right\{[^}]*\}/)?.[0],
    ].join("\n");

    expect(hydrationRules).toContain("background:transparent");
    expect(hydrationRules).not.toContain("var(--bg-canvas)");
    expect(workspaceCss).not.toContain(".ws-hydration-canvas");
  });

  it("首页新建路径立即挂载空白文档与对话列", async () => {
    mocks.controller = controller("ready");
    await act(async () => root.render(<WorkspacePage />));

    expect(host.querySelector('[data-wf="WorkspaceHydrationCanvas"]')).toBeNull();
    expect(host.querySelector(".ws-left")).not.toBeNull();
    expect(host.querySelector(".ws-right")).not.toBeNull();
  });

  it("文档领先时只挂正文，恢复完成后再挂对话", async () => {
    mocks.controller = controller("document-only", "document-then-chat");
    await act(async () => root.render(<WorkspacePage />));

    expect(host.querySelector(".ws-left")).toBeNull();
    expect(host.querySelector(".ws-right")).not.toBeNull();
    expect(host.querySelector('[data-wf="WorkspaceHydrationChat"]')).not.toBeNull();
  });
});
