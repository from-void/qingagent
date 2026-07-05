// @vitest-environment jsdom
// StarterPanel 空态引导:hover 预览残留回归(review-loop-0702 lane-B round-1)。
// 场景:hover 中的卡片因"取消收藏 / 切 tab / 切行业"被从列表移除时,该卡直接 unmount,
// onMouseLeave 永远不会触发 → hovered state 残留。修复前预览卡死在已消失的模板上,
// 空态"输入正文,开始写作"入口被顶掉(真机复现)。修复=渲染时派生校验 hovered 仍在当前列表。

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StarterPanel } from "./StarterPanel";
import { STARTER_INDUSTRIES } from "../data/starterTemplates";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function renderPanel() {
  act(() => {
    root!.render(<StarterPanel onFill={vi.fn()} onCreateBlank={vi.fn()} />);
  });
}

function firstCard(): HTMLButtonElement {
  const card = host!.querySelector<HTMLButtonElement>(".starter-card");
  expect(card).not.toBeNull();
  return card!;
}

function hoverFirstCard() {
  act(() => {
    firstCard().dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
}

function starOfFirstCard(): HTMLElement {
  const star = firstCard().querySelector<HTMLElement>(".starter-star");
  expect(star).not.toBeNull();
  return star!;
}

function previewVisible(): boolean {
  return host!.querySelector(".starter-preview") !== null;
}

function blankEntryVisible(): boolean {
  return host!.querySelector(".starter-hit-body") !== null;
}

describe("StarterPanel hover 预览残留", () => {
  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("hover 出预览,mouseleave 后恢复空态入口(基线)", () => {
    renderPanel();
    expect(blankEntryVisible()).toBe(true);

    hoverFirstCard();
    expect(previewVisible()).toBe(true);
    expect(blankEntryVisible()).toBe(false);

    act(() => {
      firstCard().dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(previewVisible()).toBe(false);
    expect(blankEntryVisible()).toBe(true);
  });

  it("收藏 tab 里 hover 中点星取消收藏(卡片 unmount 无 mouseleave),预览不残留", () => {
    renderPanel();
    // 收藏第一张卡 → 切到收藏 tab
    act(() => {
      starOfFirstCard().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const favTab = [...host!.querySelectorAll<HTMLButtonElement>(".starter-tab")].find(
      (b) => b.textContent === "收藏",
    );
    expect(favTab).toBeDefined();
    act(() => {
      favTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // hover 收藏卡出预览,然后点星取消收藏 → 卡片消失(收藏空回退推荐)
    hoverFirstCard();
    expect(previewVisible()).toBe(true);
    act(() => {
      starOfFirstCard().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // 修复前:hovered 残留,预览卡死、空态入口消失;修复后:回到空态入口
    expect(previewVisible()).toBe(false);
    expect(blankEntryVisible()).toBe(true);
  });

  it("hover 中切换行业(卡片列表整体替换),预览不残留", () => {
    renderPanel();
    hoverFirstCard();
    expect(previewVisible()).toBe(true);

    const select = host!.querySelector<HTMLSelectElement>(".starter-sel select");
    expect(select).not.toBeNull();
    const otherIndustry = STARTER_INDUSTRIES[1]!;
    act(() => {
      select!.value = otherIndustry.id;
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(previewVisible()).toBe(false);
    expect(blankEntryVisible()).toBe(true);
  });
});
