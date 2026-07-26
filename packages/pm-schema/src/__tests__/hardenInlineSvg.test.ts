import { describe, expect, it } from "vitest";
import { hardenInlineSvg, INLINE_SVG_MAX_BYTES } from "../svg/hardenInlineSvg";

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
