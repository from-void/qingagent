// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  arrayBufferToDataUrl,
  DataUrlLruCache,
  externalSvgResourceReferences,
  svgMarkupToDataUrl,
} from "./exportElementAsPng";
import { XHS_COVER_FONT_FACES, xhsCoverFontFaceCss } from "./xhsCoverFonts";

describe("衍生稿 PNG 导出资源自包含", () => {
  it("字体 data URL 缓存同时受 LRU 容量和字节预算约束", async () => {
    const byEntries = new DataUrlLruCache(2, 100);
    await byEntries.getOrLoad("a", async () => "aaaa");
    await byEntries.getOrLoad("b", async () => "bbbb");
    await byEntries.getOrLoad("a", async () => "不应重载");
    await byEntries.getOrLoad("c", async () => "cccc");
    expect(byEntries.size).toBe(2);
    expect(await byEntries.getOrLoad("a", async () => "不应重载")).toBe("aaaa");
    expect(await byEntries.getOrLoad("b", async () => "b-reloaded")).toBe("b-reloaded");

    const byBytes = new DataUrlLruCache(3, 6);
    await byBytes.getOrLoad("a", async () => "aaaa");
    await byBytes.getOrLoad("b", async () => "bbbb");
    expect(byBytes.size).toBe(1);
    expect(byBytes.byteSize).toBe(4);
  });

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

  it("正文中的 CSS 和资源标签示例不被误判为真实外链", () => {
    const tutorialSvg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      "<foreignObject>",
      '<article xmlns="http://www.w3.org/1999/xhtml">',
      "<p>背景示例：url(https://example.com/a.png)</p>",
      "<pre>@import 'https://example.com/theme.css';</pre>",
      "<code>&lt;img src=\"https://example.com/demo.png\"&gt;</code>",
      "</article>",
      "</foreignObject>",
      "</svg>",
    ].join("");

    expect(externalSvgResourceReferences(tutorialSvg)).toEqual([]);
    expect(() => svgMarkupToDataUrl(tutorialSvg)).not.toThrow();
  });
});
