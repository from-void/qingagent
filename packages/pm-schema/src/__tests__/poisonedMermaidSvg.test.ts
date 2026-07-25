import { describe, expect, it } from "vitest";
import { isPoisonedMermaidSvg } from "../mermaid/poisonedMermaidSvg";

describe("isPoisonedMermaidSvg", () => {
  it("源码与 SVG 非空但 SVG 没有 text 时判为毒缓存", () => {
    expect(isPoisonedMermaidSvg(
      '<svg viewBox="0 0 100 50"><rect width="100" height="50"/></svg>',
      "flowchart TD\n  A[开始] --> B[结束]",
    )).toBe(true);
  });

  it("包含原生 text 标签时保留缓存", () => {
    expect(isPoisonedMermaidSvg(
      '<svg viewBox="0 0 100 50"><TEXT x="10" y="20">开始</TEXT></svg>',
      "flowchart TD\n  A[开始]",
    )).toBe(false);
  });

  it.each([
    [null, "flowchart TD\n  A-->B"],
    ["", "flowchart TD\n  A-->B"],
    ['<svg viewBox="0 0 1 1"></svg>', ""],
    ['<svg viewBox="0 0 1 1"></svg>', "   "],
  ])("空 SVG 或空源码不判毒", (svg, source) => {
    expect(isPoisonedMermaidSvg(svg, source)).toBe(false);
  });
});
