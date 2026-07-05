// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Throwing({ error }: { error: Error }): never {
  throw error;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // 抑制 React 把捕获到的错误打到 console.error 的噪声(测试预期就是抛错)。
  vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => {
    root.render(createElement(ErrorBoundary, null, node));
  });
  return container;
}

describe("ErrorBoundary(防整树白屏·懒加载失败兜底)", () => {
  it("ChunkLoadError → 显示「页面已更新」+刷新按钮(而非白屏)", async () => {
    const err = new Error("Failed to fetch dynamically imported module: /assets/WorkspacePage-x.js");
    err.name = "ChunkLoadError";
    const container = await mount(createElement(Throwing, { error: err }));
    expect(container.textContent).toContain("页面已更新");
    const btn = container.querySelector("button");
    expect(btn?.textContent).toContain("刷新");
  });

  it("普通渲染错误 → 显示「出了点小问题」+刷新按钮(不白屏)", async () => {
    const container = await mount(createElement(Throwing, { error: new Error("boom") }));
    expect(container.textContent).toContain("出了点小问题");
    expect(container.querySelector("button")?.textContent).toContain("刷新");
  });

  it("子组件正常时透传渲染,不显示兜底", async () => {
    const container = await mount(createElement("div", { id: "ok" }, "正常内容"));
    expect(container.querySelector("#ok")?.textContent).toBe("正常内容");
    expect(container.textContent).not.toContain("页面已更新");
  });
});
