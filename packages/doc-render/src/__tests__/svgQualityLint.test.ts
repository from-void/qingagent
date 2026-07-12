import { describe, expect, it } from "vitest";
import { lintSvg } from "../browser/svgQualityLint.js";

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

  it("干净网格 SVG 零违规", () => {
    const issues = lintSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">
        <rect x="0" y="0" width="800" height="450" fill="#f7f1e6"/>
        <text x="48" y="64" font-size="30" fill="#2b2b2b">清晰标题</text>
        <rect x="48" y="96" width="300" height="180" fill="#ffffff"/>
        <text x="72" y="140" font-size="18" fill="#333333">短文本</text>
        <rect x="432" y="96" width="300" height="180" fill="#315c72"/>
        <text x="456" y="140" font-size="18" fill="#2b2b2b">高对比</text>
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
