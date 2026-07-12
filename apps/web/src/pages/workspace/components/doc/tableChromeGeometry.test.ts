import { describe, expect, it } from "vitest";
import { resolveTableChromeViewport } from "./tableChromeGeometry";

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
}) as DOMRect;

describe("resolveTableChromeViewport", () => {
  it("表格首屏可见时为左侧和上侧 rail 保留槽位", () => {
    expect(resolveTableChromeViewport(
      rect(100, 100, 400, 200),
      rect(90, 90, 220, 120),
      rect(0, 0, 800, 600),
    )).toEqual({ top: 78, left: 78, width: 232, height: 132 });
  });

  it("横滚后以 wrapper 可视左缘裁剪，不再采用表格未裁剪左缘", () => {
    expect(resolveTableChromeViewport(
      rect(134, 100, 1944, 200),
      rect(556, 90, 664, 120),
      rect(500, 0, 800, 600),
    )).toEqual({ top: 78, left: 556, width: 664, height: 132 });
  });

  it("wrapper 超出工作区时四边均裁到工作区", () => {
    expect(resolveTableChromeViewport(
      rect(480, -30, 600, 700),
      rect(450, -50, 900, 750),
      rect(500, 0, 800, 600),
    )).toEqual({ top: 0, left: 500, width: 800, height: 600 });
  });
});
