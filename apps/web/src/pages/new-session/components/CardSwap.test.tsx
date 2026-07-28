// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardSwap, type CardSwapHandle } from "./CardSwap";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

describe("CardSwap 当前顺序", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.useRealTimers();
  });

  it("自动轮换中提升其他卡片后，出场卡会回到当前卡组", async () => {
    vi.useFakeTimers();
    await renderCardSwap();
    const cards = getCards();

    act(() => {
      vi.advanceTimersByTime(2100);
      cards[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      vi.advanceTimersByTime(500);
    });

    expect(cards[2]?.classList.contains("top")).toBe(true);
    expect(cards.map((card) => card.style.opacity).sort()).toEqual(
      ["1", "0.88", "0.76", "0.64"].sort(),
    );
  });

  it("测量提交起点时返回现有顶卡，且不重置卡片顺序", async () => {
    vi.useFakeTimers();
    const swapRef = createRef<CardSwapHandle>();
    await renderCardSwap(swapRef);
    const cards = getCards();
    const expected = new DOMRect(30, 40, 300, 380);
    cards.forEach((card, index) => {
      card.getBoundingClientRect = vi.fn(() =>
        index === 3 ? expected : new DOMRect(index, index, 300, 380),
      );
    });

    act(() => {
      cards[3]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const rect = swapRef.current?.topCardRect();

    expect(rect).toBe(expected);
    expect(cards[3]?.classList.contains("top")).toBe(true);
    expect(cards[0]?.classList.contains("top")).toBe(false);
  });

  it("自动轮换 420ms 窗口内测量只读，不改变顺序和视觉布局", async () => {
    vi.useFakeTimers();
    const swapRef = createRef<CardSwapHandle>();
    await renderCardSwap(swapRef);
    const cards = getCards();
    const expected = new DOMRect(50, 60, 300, 380);
    cards.forEach((card, index) => {
      card.getBoundingClientRect = vi.fn(() =>
        index === 1 ? expected : new DOMRect(index, index, 300, 380),
      );
    });

    act(() => {
      vi.advanceTimersByTime(2100);
    });
    const before = cardLayoutSnapshot(cards);
    const rect = swapRef.current?.topCardRect();

    expect(rect).toBe(expected);
    expect(cardLayoutSnapshot(cards)).toEqual(before);
  });

  it("提交准备在 420ms 轮换窗口内收束布局并锁定被测卡用于飞出", async () => {
    vi.useFakeTimers();
    const swapRef = createRef<CardSwapHandle>();
    await renderCardSwap(swapRef);
    const cards = getCards();
    cards.forEach((card, index) => {
      card.getBoundingClientRect = vi.fn(() => new DOMRect(index * 10, index * 20, 300, 380));
    });

    act(() => {
      vi.advanceTimersByTime(2100);
    });
    const rect = swapRef.current?.prepareTopCard();
    const measuredCard = cards.find((card) =>
      vi.mocked(card.getBoundingClientRect).mock.calls.length > 0
    );

    expect(rect).toEqual(new DOMRect(10, 20, 300, 380));
    expect(measuredCard?.dataset.i).toBe("1");
    expect(cards.map((card) => card.style.opacity).sort()).toEqual(
      ["1", "0.88", "0.76", "0.64"].sort(),
    );

    void swapRef.current?.flyTopCard({ left: 400, top: 50, width: 800, height: 860 });
    const flyingCard = document.body.querySelector<HTMLDivElement>(".ccx-tcard.flying");
    expect(flyingCard?.dataset.i).toBe(measuredCard?.dataset.i);
    flyingCard?.remove();
  });
});

async function renderCardSwap(ref = createRef<CardSwapHandle>()): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CardSwap
        ref={ref}
        textures={{ noise: "none", inkTex: "none" }}
        onFill={() => undefined}
      />,
    );
  });
}

function getCards(): HTMLDivElement[] {
  return Array.from(host?.querySelectorAll<HTMLDivElement>(".ccx-tcard") ?? []);
}

function cardLayoutSnapshot(cards: HTMLDivElement[]) {
  return cards.map((card) => ({
    transform: card.style.transform,
    opacity: card.style.opacity,
    zIndex: card.style.zIndex,
    top: card.classList.contains("top"),
  }));
}
