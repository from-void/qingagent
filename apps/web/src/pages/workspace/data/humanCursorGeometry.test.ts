import { describe, expect, it } from "vitest";
import {
  approach,
  computeCursorAnchor,
  edgeBubbleX,
  type RectLike,
} from "./humanCursorGeometry";

const vp: RectLike = { left: 100, top: 200, width: 600, height: 400 }; // 视口 y∈[200,600]

describe("computeCursorAnchor", () => {
  it("目标在视口内 → visible,edge none,锚左上偏内", () => {
    const a = computeCursorAnchor({ left: 300, top: 350, width: 200, height: 20 }, vp);
    expect(a.visible).toBe(true);
    expect(a.edge).toBe("none");
    expect(a.y).toBe(350);
    expect(a.x).toBe(308); // left + min(8, w/2)
  });
  it("目标在视口上方 → edge top,y 夹到视口顶", () => {
    const a = computeCursorAnchor({ left: 300, top: 50, width: 200, height: 20 }, vp);
    expect(a.visible).toBe(false);
    expect(a.edge).toBe("top");
    expect(a.y).toBe(200);
  });
  it("目标在视口下方 → edge bottom,y 夹到视口底", () => {
    const a = computeCursorAnchor({ left: 300, top: 900, width: 200, height: 20 }, vp);
    expect(a.visible).toBe(false);
    expect(a.edge).toBe("bottom");
    expect(a.y).toBe(600);
  });
});

describe("approach(平滑趋近)", () => {
  it("follow=1 直达,follow=0 不动,0..1 之间按比例靠近", () => {
    expect(approach(0, 100, 1)).toBe(100);
    expect(approach(0, 100, 0)).toBe(0);
    expect(approach(0, 100, 0.25)).toBe(25);
  });
  it("越界 follow 自动夹到 [0,1]", () => {
    expect(approach(0, 100, 5)).toBe(100);
    expect(approach(10, 0, -1)).toBe(10);
  });
  it("逐帧调用单调逼近目标(不过冲)", () => {
    let x = 0;
    let prev = -1;
    for (let i = 0; i < 200; i++) {
      x = approach(x, 100, 0.1);
      expect(x).toBeGreaterThanOrEqual(prev);
      expect(x).toBeLessThanOrEqual(100);
      prev = x;
    }
    expect(x).toBeCloseTo(100, 1);
  });
});

describe("edgeBubbleX", () => {
  it("多个同向越界鼠标沿边缘居中并排,间距一致", () => {
    const x0 = edgeBubbleX(0, 3, vp, 30);
    const x1 = edgeBubbleX(1, 3, vp, 30);
    const x2 = edgeBubbleX(2, 3, vp, 30);
    expect(x1 - x0).toBe(30);
    expect(x2 - x1).toBe(30);
    // 居中:中间那个约在视口水平中心
    expect(x1).toBe(vp.left + vp.width / 2);
  });
});
