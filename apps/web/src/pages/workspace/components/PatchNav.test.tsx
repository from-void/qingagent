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
    expect(host?.textContent).toContain("放弃全部");
  });

  it("用剩余口径展示待处理处数", async () => {
    await renderPatchNav(baseProps({ totalCount: 3, remainingCount: 2 }));

    expect(host?.textContent).toContain("剩余 · 3 处");
    expect(host?.querySelector(".pn-label")?.getAttribute("title")).toBe("剩余 2 处");
  });

  it("放弃全部仍保留确认二次点击", async () => {
    const onRejectAll = vi.fn();
    await renderPatchNav(baseProps({ onRejectAll }));

    act(() => {
      buttonByText("放弃全部").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host?.textContent).toContain("确认放弃全部");

    act(() => {
      buttonByText("确认放弃全部").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRejectAll).toHaveBeenCalledTimes(1);
  });
});
