import { describe, expect, it } from "vitest";
import { estimateTextWidth, lintSvg } from "../browser/svgQualityLint.js";

const size = { width: 800, height: 450 };

describe("lintSvg", () => {
  it("命中文本横向溢出", () => {
    const issues = lintSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">
        <text x="760" y="80" font-size="20" fill="#2b2b2b">一二三四五六七八九十</text>
      </svg>`,
      size,
    );

    expect(issues.some((issue) => issue.rule === "text-overflow")).toBe(true);
  });

  it("命中两段同位文本重叠", () => {
    const issues = lintSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">
        <text x="100" y="100" font-size="20" fill="#2b2b2b">第一段文本</text>
        <text x="100" y="100" font-size="20" fill="#2b2b2b">第二段文本</text>
      </svg>`,
      size,
    );

    expect(issues.some((issue) => issue.rule === "text-overlap")).toBe(true);
  });

  it("命中默认米黄底上的低对比文本", () => {
    const issues = lintSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">
        <text x="80" y="80" font-size="18" fill="#f0e8d8">低对比文字</text>
      </svg>`,
      size,
    );

    expect(issues.some((issue) => issue.rule === "low-contrast")).toBe(true);
  });

  it("官方双栏骨架的深色卡片白字不误报低对比度", () => {
    const issues = lintSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">
        <rect x="0" y="0" width="800" height="450" fill="#f7f1e6"/><text x="48" y="56" font-size="30" fill="#2b2b2b">标题</text>
        <rect x="48" y="96" width="320" height="270" fill="#ffffff"/><text x="72" y="138" font-size="20" fill="#2b2b2b">左栏</text>
        <text x="72" y="178" font-size="16" fill="#333333"><tspan x="72">要点</tspan><tspan x="72" dy="1.4em">换行</tspan></text>
        <rect x="432" y="96" width="320" height="270" fill="#2f5d62"/><text x="456" y="138" font-size="20" fill="#ffffff">右栏</text>
        <text x="456" y="178" font-size="16" fill="#ffffff"><tspan x="456">要点</tspan><tspan x="456" dy="1.4em">换行</tspan></text>
      </svg>`,
      size,
    );

    expect(issues.filter((issue) => issue.rule === "low-contrast")).toEqual([]);
  });

  it("命中局部深色卡片上的深色文字", () => {
    const issues = lintSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">
        <rect x="0" y="0" width="800" height="450" fill="#f7f1e6"/>
        <rect x="48" y="96" width="320" height="180" fill="#2f5d62"/>
        <text x="72" y="140" font-size="18" fill="#333333">局部低对比</text>
      </svg>`,
      size,
    );

    expect(issues.some((issue) => issue.rule === "low-contrast")).toBe(true);
  });

  it("无法可靠确定非矩形局部背景时跳过对比度判定", () => {
    const issues = lintSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">
        <circle cx="200" cy="160" r="100" fill="#2f5d62"/>
        <text x="150" y="170" font-size="20" fill="#ffffff">圆形承载</text>
      </svg>`,
      size,
    );

    expect(issues.filter((issue) => issue.rule === "low-contrast")).toEqual([]);
  });

  it("defs 中未绘制矩形不得覆盖实际米黄背景判断", () => {
    const issues = lintSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">
        <defs><rect x="0" y="0" width="800" height="450" fill="#2f5d62"/></defs>
        <rect x="0" y="0" width="800" height="450" fill="#f7f1e6"/>
        <text x="80" y="80" font-size="18" fill="#ffffff">米黄底白字</text>
      </svg>`,
      size,
    );

    expect(issues.some((issue) => issue.rule === "low-contrast")).toBe(true);
  });

  it("百分比半透明局部层无法可靠确定合成背景时跳过对比度", () => {
    const issues = lintSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">
        <rect x="0" y="0" width="800" height="450" fill="#ffffff"/>
        <rect x="48" y="48" width="320" height="180" fill="#2f5d62" fill-opacity="50%"/>
        <text x="72" y="100" font-size="18" fill="#333333">合成背景不确定</text>
      </svg>`,
      size,
    );

    expect(issues.filter((issue) => issue.rule === "low-contrast")).toEqual([]);
  });

  it("大元素集合只需一次绘制顺序扫描即可完成对比度检查", () => {
    const shapes = Array.from(
      { length: 2_500 },
      (_, index) =>
        `<rect x="${index % 800}" y="${index % 450}" width="1" height="1" fill="#ffffff"/>`,
    ).join("");
    const issues = lintSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">
        ${shapes}
        <rect x="48" y="48" width="320" height="180" fill="#2f5d62"/>
        <text x="72" y="100" font-size="18" fill="#ffffff">高对比文字</text>
      </svg>`,
      size,
    );

    expect(issues.filter((issue) => issue.rule === "low-contrast")).toEqual([]);
  });

  it("干净网格 SVG 零违规", () => {
    const issues = lintSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">
        <rect x="0" y="0" width="800" height="450" fill="#f7f1e6"/>
        <text x="48" y="64" font-size="30" fill="#2b2b2b">清晰标题</text>
        <rect x="48" y="96" width="300" height="180" fill="#ffffff"/>
        <text x="72" y="140" font-size="18" fill="#333333">短文本</text>
        <rect x="432" y="96" width="300" height="180" fill="#315c72"/>
        <text x="456" y="140" font-size="18" fill="#ffffff">高对比</text>
      </svg>`,
      size,
    );

    expect(issues).toEqual([]);
  });

  it("畸形 XML 或非 svg 根返回空违规", () => {
    expect(lintSvg(`<svg><text x="10" y="10">坏</svg>`, size)).toEqual([]);
    expect(lintSvg(`<div><text x="10" y="10">非 SVG</text></div>`, size)).toEqual([]);
  });
});

describe("estimateTextWidth", () => {
  it("将假名、Hangul 与全角字符按全宽估算", () => {
    expect(estimateTextWidth("あア한Ａ", 10)).toBe(40);
  });
});
