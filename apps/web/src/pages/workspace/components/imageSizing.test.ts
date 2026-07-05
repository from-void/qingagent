import { describe, expect, it } from "vitest";
import { DEFAULT_SVG_WIDTH, isSvgSrc, svgFallbackWidth } from "./imageSizing";

describe("imageSizing svg width 兜底", () => {
  it("识别 SVG 源(扩展名/查询串/data URI)", () => {
    expect(isSvgSrc("/api/v1/files/abc/illustration.svg")).toBe(true);
    expect(isSvgSrc("/api/v1/files/abc/illustration.svg?v=2")).toBe(true);
    expect(isSvgSrc("data:image/svg+xml;base64,xxx")).toBe(true);
    expect(isSvgSrc("/api/v1/files/abc/photo.png")).toBe(false);
    expect(isSvgSrc("https://x/y.jpg")).toBe(false);
  });

  // 回归 svg-generateimage-zero-size：无 width 的 SVG 必须拿到默认宽,否则 figure 塌 0×0。
  it("无 width 的 SVG 源兜底默认宽,位图保持 null(内禀尺寸)", () => {
    expect(svgFallbackWidth("/files/x/illustration.svg", null)).toBe(DEFAULT_SVG_WIDTH);
    expect(svgFallbackWidth("/files/x/photo.png", null)).toBe(null);
  });

  it("已有显式 width 时优先用显式值(用户 resize 不被覆盖)", () => {
    expect(svgFallbackWidth("/files/x/illustration.svg", 320)).toBe(320);
    expect(svgFallbackWidth("/files/x/photo.png", 200)).toBe(200);
  });
});
