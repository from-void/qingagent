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
    canActOnCurrent: true,
    currentVerdict: null,
    onJumpPrev: vi.fn(),
    onJumpNext: vi.fn(),
    onAcceptCurrent: vi.fn(),
    onRejectCurrent: vi.fn(),
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

  it("采纳/拒绝此处会调用当前项回调", async () => {
    const onAcceptCurrent = vi.fn();
    const onRejectCurrent = vi.fn();
    await renderPatchNav(baseProps({ onAcceptCurrent, onRejectCurrent }));

    act(() => {
      buttonByText("采纳此处").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      buttonByText("拒绝此处").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAcceptCurrent).toHaveBeenCalledTimes(1);
    expect(onRejectCurrent).toHaveBeenCalledTimes(1);
  });

  it("用剩余口径展示待处理处数", async () => {
    await renderPatchNav(baseProps({ totalCount: 3, remainingCount: 2 }));

    expect(host?.textContent).toContain("剩余 · 3 处");
    expect(host?.querySelector(".pn-label")?.getAttribute("title")).toBe("剩余 2 处");
  });

  it("当前 verdict 对应按钮禁用,另一个按钮可切换", async () => {
    await renderPatchNav(baseProps({ currentVerdict: "accepted" }));

    expect(buttonByText("采纳此处").disabled).toBe(true);
    expect(buttonByText("拒绝此处").disabled).toBe(false);
  });

  it("当前无 hunk 时逐条操作禁用", async () => {
    await renderPatchNav(baseProps({
      totalCount: 0,
      activePatchIndex: -1,
      canActOnCurrent: false,
    }));

    expect(buttonByText("采纳此处").disabled).toBe(true);
    expect(buttonByText("拒绝此处").disabled).toBe(true);
  });
});
