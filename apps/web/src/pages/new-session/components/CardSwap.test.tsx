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
