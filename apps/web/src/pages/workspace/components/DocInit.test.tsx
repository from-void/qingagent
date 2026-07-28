// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocInit } from "./DocInit";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("恢复失败态自带重试按钮，且不再出现指向不存在入口的文案", () => {
  const onRetry = vi.fn();
  act(() => {
    root.render(<DocInit mode="error" title="恢复失败" onRetry={onRetry} />);
  });

  expect(host.textContent).toContain("恢复失败");
  expect(host.textContent).not.toContain("请点击上方重试");
  const button = host.querySelector<HTMLButtonElement>('[data-wf="DocInitRetry"]');
  expect(button?.textContent).toBe("重试");

  act(() => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it("不给 onRetry 时不渲染按钮，也不渲染空副标题", () => {
  act(() => {
    root.render(<DocInit mode="error" title="恢复失败" />);
  });

  expect(host.querySelector('[data-wf="DocInitRetry"]')).toBeNull();
  expect(host.querySelector(".doc-empty-sub")).toBeNull();
});

it("生成中态保留默认副标题", () => {
  act(() => {
    root.render(<DocInit mode="drafting" />);
  });

  expect(host.querySelector(".doc-empty-sub")?.textContent).toBe("写作中 · 请稍候");
});
