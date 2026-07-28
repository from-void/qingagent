import { describe, expect, it } from "vitest";
import {
  dropColorSchemeMediaBlocks,
  flattenAdaptiveSvgColors,
  hardenInlineSvg,
  INLINE_SVG_MAX_BYTES,
} from "../svg/hardenInlineSvg";

describe("hardenInlineSvg 脏形态安全边界", () => {
  it("移除 foreignObject 与 SMIL animate/set 节点", () => {
    const hardened = hardenInlineSvg(
      '<svg><foreignObject><div>外部内容</div></foreignObject><animate attributeName="href" to="https://evil.example"/><set attributeName="fill" to="url(https://evil.example/a)"/><rect/></svg>',
    );

    expect(hardened).toContain("<rect");
    expect(hardened).not.toMatch(/foreignObject|animate|<set\b/i);
  });

  it("移除 xlink:href 外联，但保留本地片段引用", () => {
    const hardened = hardenInlineSvg(
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use id="external" xlink:href="https://evil.example/a.svg#x"/><use id="local" xlink:href="#safe"/></svg>',
    );

    expect(hardened).not.toContain("https://evil.example");
    expect(hardened).toContain('xlink:href="#safe"');
  });

  it("移除 style 属性与 style 节点中的外联 url()", () => {
    const hardened = hardenInlineSvg(
      '<svg><rect style="fill:url(https://evil.example/a.svg#x)"/><style>.x{fill:url("https://evil.example/b.svg#y")}</style><path fill="url(#safe)"/></svg>',
    );

    expect(hardened).not.toContain("https://evil.example");
    expect(hardened).not.toMatch(/<rect[^>]+\bstyle=/);
    expect(hardened).toMatch(/<style(?:\/>|><\/style>)/);
    expect(hardened).toContain('fill="url(#safe)"');
  });

  it.each([
    ["DOCTYPE", '<!DOCTYPE svg><svg/>'],
    ["ENTITY", '<svg><!ENTITY payload "x"></svg>'],
  ])("拒绝 %s 声明", (_label, raw) => {
    expect(hardenInlineSvg(raw)).toBeNull();
  });

  it("拒绝达到 200KB 输入上限之外的数据", () => {
    const oversized = `<svg>${" ".repeat(INLINE_SVG_MAX_BYTES)}</svg>`;
    expect(hardenInlineSvg(oversized)).toBeNull();
  });

  it("拒绝超过 5000 个元素的 SVG", () => {
    const oversized = `<svg>${"<g/>".repeat(5_000)}</svg>`;
    expect(hardenInlineSvg(oversized)).toBeNull();
  });

  it.each([
    ["畸形 XML", "<svg><g></svg>"],
    ["非 svg 根", "<html><svg/></html>"],
  ])("拒绝%s", (_label, raw) => {
    expect(hardenInlineSvg(raw)).toBeNull();
  });
});

describe("自适应主题颜色压成浅色一版", () => {
  // draw.io 8.x 的原生导出真实形态：fill 属性写浅色，内联 style 用 light-dark()
  // 盖住它；查看端一旦落到深色 scheme，整张图就渲染成黑块。
  const DRAWIO_EXPORTED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" style="background: #ffffff; background-color: light-dark(#ffffff, #121212);" width="337" height="77">'
    + '<rect x="8" y="8" width="120" height="60" fill="#efe3cc" stroke="#b08a3e" style="fill: light-dark(rgb(239, 227, 204), rgb(35, 28, 12)); stroke: light-dark(rgb(176, 138, 62), rgb(72, 52, 15));"/>'
    + '<g fill="#2f2a22" style="fill: light-dark(#2f2a22, #e2ddd3);"><text x="68" y="43">开始</text></g>'
    + '<style>@media (prefers-color-scheme: dark){#ge-svg-1{--ge-svg-background: #121212}} text{font-family:Arial}</style>'
    + "</svg>";

  it("drawio 导出的 SVG 落盘后填充色是浅色而不是深黑", () => {
    const hardened = hardenInlineSvg(DRAWIO_EXPORTED_SVG);

    expect(hardened).not.toContain("light-dark");
    expect(hardened).toContain("fill: rgb(239, 227, 204)");
    expect(hardened).toContain("stroke: rgb(176, 138, 62)");
    expect(hardened).toContain("background-color: #ffffff");
    expect(hardened).not.toContain("#121212");
    expect(hardened).not.toContain("prefers-color-scheme");
    // 与主题无关的样式照常保留。
    expect(hardened).toContain("font-family:Arial");
    expect(hardened).toContain("开始");
  });

  it("嵌套与畸形的 light-dark 表达式都不会丢内容", () => {
    expect(flattenAdaptiveSvgColors("fill: light-dark(light-dark(#fff, #000), #111)")).toBe("fill: #fff");
    expect(flattenAdaptiveSvgColors("fill: light-dark(var(--a, #fff), #000)")).toBe("fill: var(--a, #fff)");
    expect(flattenAdaptiveSvgColors("fill: light-dark(#fff")).toBe("fill: light-dark(#fff");
    expect(flattenAdaptiveSvgColors("fill: #abc")).toBe("fill: #abc");
  });

  it("只删深浅配色的媒体查询，其它媒体块保留", () => {
    expect(dropColorSchemeMediaBlocks("a{fill:red}@media (prefers-color-scheme: dark){a{fill:black}}b{fill:blue}"))
      .toBe("a{fill:red}b{fill:blue}");
    expect(dropColorSchemeMediaBlocks("@media print{a{fill:red}}"))
      .toBe("@media print{a{fill:red}}");
  });
});
