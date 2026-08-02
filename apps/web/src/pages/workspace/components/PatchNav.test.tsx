// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatchNav, type PatchNavProps } from "./PatchNav";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function baseProps(overrides: Partial<PatchNavProps> = {}): PatchNavProps {
  return {
    remainingCount: 2,
    totalCount: 2,
    activePatchIndex: 0,
    onJumpPrev: vi.fn(),
    onJumpNext: vi.fn(),
    onRejectAll: vi.fn(),
    onCommit: vi.fn(),
    ...overrides,
  };
}

async function renderPatchNav(props: PatchNavProps): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<PatchNav {...props} />);
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...host!.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

describe("PatchNav", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    host?.remove();
    host = null;
  });

  it("工具栏不再渲染逐处采纳/拒绝按钮", async () => {
    await renderPatchNav(baseProps());

    expect(host?.textContent).not.toContain("采纳此处");
    expect(host?.textContent).not.toContain("拒绝此处");
    expect(host?.textContent).toContain("上一处");
    expect(host?.textContent).toContain("下一处");
    expect(host?.textContent).toContain("提交 ↵");
    // 「全部应用」已按用户拍板移除:提交本身默认应用未裁决的全部修改
    expect(host?.textContent).not.toContain("全部应用");
    expect(host?.textContent).toContain("放弃全部");
  });

  it("用剩余口径展示待处理处数", async () => {
    await renderPatchNav(baseProps({ totalCount: 3, remainingCount: 2 }));

    expect(host?.textContent).toContain("剩余 · 2 处");
    expect(host?.textContent).not.toContain("剩余 · 3 处");
    expect(host?.querySelector(".pn-label")?.getAttribute("title")).toBe("剩余 2 处");
  });

  it("正文无法定位时仍给整轮提交与放弃入口", async () => {
    await renderPatchNav(baseProps({
      totalCount: 0,
      remainingCount: 1,
      unrenderableOnly: true,
    }));

    expect(host?.textContent).toContain("修改候选待确认");
    expect(host?.textContent).not.toContain("剩余 ·");
    expect(host?.textContent).not.toContain("上一处");
    expect(host?.textContent).not.toContain("下一处");
    expect(buttonByText("提交 ↵")).toBeTruthy();
    expect(buttonByText("放弃全部")).toBeTruthy();
    expect(
      host?.querySelector('[data-wf="PatchNav"]')?.getAttribute("data-review-fallback"),
    ).toBe("true");
  });

  it("放弃全部以内联确认态替换底栏并保留二次点击", async () => {
    const onRejectAll = vi.fn();
    await renderPatchNav(baseProps({ onRejectAll }));

    act(() => {
      buttonByText("放弃全部").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host?.textContent).toContain("确认放弃全部");
    expect(host?.querySelector(".patch-nav")?.classList.contains("is-confirming")).toBe(true);
    expect(host?.querySelector(".pn-confirm-inline")).not.toBeNull();
    expect(host?.querySelector(".pn-confirm")).toBeNull();
    expect(host?.textContent).not.toContain("提交 ↵");
    expect(document.activeElement).toBe(buttonByText("取消"));

    act(() => {
      buttonByText("确认放弃全部").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRejectAll).toHaveBeenCalledTimes(1);
  });

  it("确认态按 Escape 取消并将焦点还给放弃入口", async () => {
    const onRejectAll = vi.fn();
    await renderPatchNav(baseProps({ onRejectAll }));

    act(() => {
      buttonByText("放弃全部").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.activeElement).toBe(buttonByText("取消"));

    act(() => {
      buttonByText("取消").dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }));
    });

    expect(onRejectAll).not.toHaveBeenCalled();
    expect(host?.textContent).not.toContain("确认放弃全部");
    expect(document.activeElement).toBe(buttonByText("放弃全部"));
  });

  it("提交中禁用提交与放弃入口", async () => {
    await renderPatchNav(baseProps({ isSubmitting: true }));

    expect(buttonByText("提交 ↵").disabled).toBe(true);
    expect(buttonByText("放弃全部").disabled).toBe(true);
    expect(host?.querySelector('[data-wf="PatchNav"]')?.getAttribute("aria-busy")).toBe("true");
  });
});
