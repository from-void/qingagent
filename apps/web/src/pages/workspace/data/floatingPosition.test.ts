import { describe, expect, it } from "vitest";
import {
  intersectFloatingAnchor,
  resolveAnchoredBubblePosition,
  resolveCenteredFloatingPosition,
  resolveSideFloatingPosition,
  shouldFlipDropdownUp,
} from "./floatingPosition";

describe("floatingPosition", () => {
  it("clamps a centered toolbar fully inside the viewport near left and bottom edges", () => {
    const pos = resolveCenteredFloatingPosition(
      { top: 20, bottom: 48, left: 2, width: 12 },
      { width: 360, height: 40 },
      { width: 390, height: 220 },
    );

    expect(pos.left).toBe(188);
    expect(pos.top).toBe(58);
    expect(pos.top + 40).toBeLessThanOrEqual(212);
    // 上方放不下翻到下方,caret 应朝上
    expect(pos.placement).toBe("below");
  });

  it("keeps a centered toolbar above the anchor when there is room", () => {
    const pos = resolveCenteredFloatingPosition(
      { top: 300, bottom: 330, left: 200, width: 40 },
      { width: 360, height: 40 },
      { width: 800, height: 600 },
    );
    expect(pos.top).toBe(250);
    expect(pos.placement).toBe("above");
  });

  it("clamps a centered toolbar inside paper horizontal bounds", () => {
    const pos = resolveCenteredFloatingPosition(
      { top: 300, bottom: 330, left: 1200, width: 100 },
      { width: 620, height: 40 },
      { width: 1400, height: 600 },
      { margin: 8, horizontalBounds: { left: 500, right: 1300 } },
    );
    expect(pos.left).toBe(982);
    expect(pos.left - 310).toBeGreaterThanOrEqual(508);
    expect(pos.left + 310).toBeLessThanOrEqual(1292);
  });

  it("uses the visible intersection as the floating anchor", () => {
    expect(intersectFloatingAnchor(
      { top: 100, bottom: 180, left: 134, width: 1944 },
      { top: 90, right: 1220, bottom: 210, left: 556 },
    )).toEqual({ top: 100, bottom: 180, left: 556, width: 664 });
  });

  it("keeps an anchored link bubble in the viewport", () => {
    const pos = resolveAnchoredBubblePosition(
      { top: 180, bottom: 210, left: 360, width: 20 },
      { width: 320, height: 42 },
      { width: 390, height: 240 },
    );

    expect(pos.left).toBe(62);
    expect(pos.top).toBe(130);
    // 下方放不下翻到上方
    expect(pos.placement).toBe("above");
  });

  it("detects dropdowns that must flip upward", () => {
    expect(shouldFlipDropdownUp(180, 120, 260)).toBe(true);
    expect(shouldFlipDropdownUp(80, 120, 260)).toBe(false);
  });

  it("侧向二级浮层优先放右侧，越界时翻到左侧并钳制纵向位置", () => {
    expect(resolveSideFloatingPosition(
      { top: 20, bottom: 50, left: 20, width: 100 },
      { width: 200, height: 160 },
      { width: 600, height: 400 },
    )).toEqual({ top: 20, left: 126, placement: "right" });
    expect(resolveSideFloatingPosition(
      { top: 360, bottom: 390, left: 420, width: 100 },
      { width: 200, height: 160 },
      { width: 600, height: 400 },
    )).toEqual({ top: 232, left: 214, placement: "left" });
  });
});
