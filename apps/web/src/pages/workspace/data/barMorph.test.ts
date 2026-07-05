// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { magicMoveFromRect, magicMoveToRect, type Rect } from "./barMorph";

const rect = (left: number, top: number, width: number, height: number): Rect => ({
  left,
  top,
  width,
  height,
});

describe("magicMoveFromRect(进场:钉到输入框矩形→几何形变到条)", () => {
  let el: HTMLElement;
  let onArrive: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("div");
    document.body.appendChild(el);
    onArrive = vi.fn();
  });
  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fromRect 为 null → 直接到位、不设几何", () => {
    magicMoveFromRect(el, null, { onArrive });
    expect(onArrive).toHaveBeenCalledTimes(1);
    expect(el.style.left).toBe("");
    expect(el.style.position).toBe("");
  });

  it("元素无尺寸(getBoundingClientRect 全 0)→ 直接到位", () => {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect(0, 0, 0, 0) as DOMRect);
    magicMoveFromRect(el, rect(10, 10, 100, 40), { onArrive });
    expect(onArrive).toHaveBeenCalledTimes(1);
  });

  it("有效 → 钉成 fixed、过渡到自然几何(dest 的 left/width),挂 transition,未同步到位", () => {
    // dest(条自然落点)
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect(400, 300, 560, 50) as DOMRect);
    // from(输入框矩形:更矮更靠左)
    magicMoveFromRect(el, rect(40, 700, 360, 120), { onArrive });
    expect(el.style.position).toBe("fixed");
    expect(el.style.boxSizing).toBe("border-box");
    // 结束态 = dest 几何(尺寸也在变,不只是位移)
    expect(el.style.left).toBe("400px");
    expect(el.style.width).toBe("560px");
    expect(el.style.height).toBe("50px");
    expect(el.style.transition).toContain("width");
    expect(el.style.transition).toContain("height");
    expect(onArrive).not.toHaveBeenCalled();
  });

  it("回归:到位(超时兜底)后清掉所有 inline 几何(unpin),让条回 CSS 定位、能跟 resize、不残留旧像素落点", () => {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect(400, 300, 560, 50) as DOMRect);
    magicMoveFromRect(el, rect(40, 700, 360, 120), { onArrive });
    expect(el.style.left).toBe("400px"); // 形变中:有 inline 几何
    vi.advanceTimersByTime(560 + 80 + 1); // 超过 durationMs + 兜底
    // 到位后:inline 定位几何全部清掉(回 CSS,从而能跟 resize),onArrive 触发。
    // (不查 margin/maxWidth/boxSizing —— jsdom 对 margin 简写/拆分的处理会让 el.style.margin 仍读到 "0px",
    //  真浏览器 removeProperty 会清掉;e2e 已实测 inlineLeft=(none)。)
    for (const p of ["position", "left", "top", "right", "bottom", "width", "height", "transition"] as const) {
      expect(el.style[p]).toBe("");
    }
    expect(onArrive).toHaveBeenCalledTimes(1);
  });
});

describe("magicMoveToRect(返回:条几何形变回输入框矩形并停住)", () => {
  let el: HTMLElement;
  let onArrive: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("div");
    document.body.appendChild(el);
    onArrive = vi.fn();
  });
  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("toRect 为 null → 直接到位", () => {
    magicMoveToRect(el, null, { onArrive });
    expect(onArrive).toHaveBeenCalledTimes(1);
  });

  it("有效 → 从当前几何过渡到 toRect(输入框矩形),挂 transition,未同步到位", () => {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect(400, 300, 560, 50) as DOMRect);
    magicMoveToRect(el, rect(40, 700, 360, 120), { onArrive });
    expect(el.style.left).toBe("40px");
    expect(el.style.width).toBe("360px");
    expect(el.style.height).toBe("120px");
    expect(el.style.transition).toContain("left");
    expect(onArrive).not.toHaveBeenCalled();
  });
});
