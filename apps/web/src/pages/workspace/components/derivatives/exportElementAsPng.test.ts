import { describe, expect, it } from "vitest";
import {
  arrayBufferToDataUrl,
  externalSvgResourceReferences,
  svgMarkupToDataUrl,
} from "./exportElementAsPng";
import { XHS_COVER_FONT_FACES, xhsCoverFontFaceCss } from "./xhsCoverFonts";

describe("衍生稿 PNG 导出资源自包含", () => {
  it("把字体二进制编码为 base64 data URI", () => {
    const buffer = new Uint8Array([0, 1, 2, 253, 254, 255]).buffer;
    expect(arrayBufferToDataUrl(buffer, "font/woff2")).toBe("data:font/woff2;base64,AAEC/f7/");
  });

  it("封面字体规则可替换为内联 WOFF2，且不再引用字体路径", () => {
    const css = xhsCoverFontFaceCss(
      XHS_COVER_FONT_FACES.poster,
      "data:font/woff2;base64,AAEC",
    );
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><style>${css}</style><strong style="font-family:'Qing Smiley Sans'">标题</strong></div></foreignObject></svg>`;

    expect(css).toContain('src:url("data:font/woff2;base64,AAEC")');
    expect(css).toContain("font-display:swap");
    expect(css).not.toContain("/fonts/");
    expect(externalSvgResourceReferences(svg)).toEqual([]);
  });

  it("外层 SVG 使用 data URL，并拒绝 blob、外链图片与 @import", () => {
    const cleanSvg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml" style="background-image:url(\'data:image/png;base64,AA==\')">正文</div></foreignObject></svg>';
    const dataUrl = svgMarkupToDataUrl(cleanSvg);

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(decodeURIComponent(dataUrl.split(",", 2)[1] ?? "")).toBe(cleanSvg);
    expect(() => svgMarkupToDataUrl('<svg><image src="blob:http://localhost/id"/></svg>')).toThrow("blob:http://localhost/id");
    expect(() => svgMarkupToDataUrl('<svg><foreignObject><img src="https://cdn.example/a.png"/></foreignObject></svg>')).toThrow("https://cdn.example/a.png");
    expect(() => svgMarkupToDataUrl('<svg><foreignObject><div style="background-image:url(&quot;/paper.png&quot;)"/></foreignObject></svg>')).toThrow("/paper.png");
    expect(() => svgMarkupToDataUrl('<svg><use href="https://cdn.example/symbols.svg#star"/></svg>')).toThrow("https://cdn.example/symbols.svg#star");
    expect(() => svgMarkupToDataUrl("<svg><style>@import '/font.css';</style></svg>")).toThrow("@import");
  });
});
