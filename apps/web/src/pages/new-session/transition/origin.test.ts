import { describe, expect, it } from "vitest";
import { computeWorkspaceDocRect } from "./origin";

describe("computeWorkspaceDocRect", () => {
  it("R4-002 宽屏文档纸仍封顶 800px", () => {
    const rect = computeWorkspaceDocRect(1440, 900);

    expect(rect.width).toBe(800);
    expect(rect.left + rect.width).toBeLessThanOrEqual(1440);
  });

  it("窄视口文档纸定宽 800、整组靠左(放不下由 .ws-body 横向滚动,不再收窄)", () => {
    // #8:左右栏定宽不压缩。computeWorkspaceDocRect 与 ws-body 的 safe-center 一致——
    // 放不下时回退到 start:left = padding(40) + chat(400) + gap(48) = 488,doc 仍 800、允许右溢(滚动)。
    for (const vw of [768, 900]) {
      const rect = computeWorkspaceDocRect(vw, 900);
      expect(rect.width).toBe(800);
      expect(rect.left).toBe(40 + 400 + 48);
    }
  });
});
