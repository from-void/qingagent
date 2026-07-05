import { describe, expect, it } from "vitest";
import { buildPartialSvgDraft, hardenInlineSvg, sanitizeSvg, SVG_MAX_BYTES, utf8ByteLength } from "../browser/svgSanitize.js";

const size = { width: 10, height: 10 };

describe("sanitizeSvg", () => {
  it("removes executable content while preserving safe shapes", () => {
    const out = sanitizeSvg(`<svg onload="alert(1)"><script>x()</script><rect width="10" height="10"/></svg>`, size);

    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/onload/i);
    expect(out).toMatch(/<rect/i);
    expect(out).toContain(`role="img"`);
  });

  it("strips external and javascript references while allowing local paint references", () => {
    const out = sanitizeSvg(
      `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="grad"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect fill="url(#grad)" stroke="url(http://evil/x)"/><image href="http://evil/x.png"/><a xlink:href="javascript:alert(1)"><circle r="1"/></a><path fill="url(data:image/png;base64,abc)"/></svg>`,
      size,
    );

    expect(out).not.toContain("evil");
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/data:image/i);
    expect(out).not.toMatch(/<image/i);
    expect(out).not.toMatch(/<a[\s>]/i);
    expect(out).toContain(`fill="url(#grad)"`);
  });

  it("strips CSS-escaped external url() from style without dropping safe shapes", () => {
    const escaped = sanitizeSvg(
      String.raw`<svg><rect width="10" height="10" style="fill:\75\72\6c(https://evil.test/p.svg#x);stroke:red"/></svg>`,
      size,
    );
    const safe = sanitizeSvg(`<svg><rect width="10" height="10" fill="red"/></svg>`, size);

    expect(escaped).not.toContain("evil.test");
    expect(escaped).not.toContain(String.raw`\75\72\6c`);
    expect(escaped).not.toMatch(/url\(/i);
    expect(escaped).toMatch(/<rect/i);
    expect(safe).toMatch(/<rect/i);
    expect(safe).toContain(`fill="red"`);
  });

  it("keeps clean SVGs stable", () => {
    const clean = `<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#abc"/></svg>`;
    const once = sanitizeSvg(clean, size);
    const twice = sanitizeSvg(once, size);

    expect(once).toMatch(/<rect/i);
    expect(once).toContain(`viewBox="0 0 10 10"`);
    expect(twice).toBe(once);
  });

  it("保留子元素(背景 rect)的 width/height,但删掉根 svg 的 width/height", () => {
    const bg = `<svg width="800" height="450"><rect x="0" y="0" width="800" height="450" fill="#0a0a2a"/><circle cx="5" cy="5" r="3" fill="#fff"/></svg>`;
    const out = sanitizeSvg(bg, { width: 800, height: 450 });
    // 背景 rect 的尺寸必须存活(否则塌成 0×0、背景消失)
    expect(out).toMatch(/<rect[^>]*\bwidth="800"/i);
    expect(out).toMatch(/<rect[^>]*\bheight="450"/i);
    expect(out).toContain(`fill="#0a0a2a"`);
    // 根 <svg> 的 width/height 仍被删除(靠 viewBox 缩放)
    expect(out).not.toMatch(/<svg[^>]*\bwidth=/i);
    expect(out).not.toMatch(/<svg[^>]*\bheight=/i);
    expect(out).toContain("viewBox=");
  });

  it("uses UTF-8 bytes instead of JavaScript character count for size limits", () => {
    const prefix = "<svg><text>";
    const suffix = "</text></svg>";
    const raw = `${prefix}${"中".repeat(Math.floor((SVG_MAX_BYTES - prefix.length - suffix.length) / 3) + 1)}${suffix}`;

    expect(raw.length).toBeLessThan(SVG_MAX_BYTES);
    expect(utf8ByteLength(raw)).toBeGreaterThan(SVG_MAX_BYTES);
    expect(sanitizeSvg(raw, size)).toBe("");
  });

  it("keeps ASCII input at the byte limit and rejects one byte over it", () => {
    const prefix = "<svg><text>";
    const suffix = "</text></svg>";
    const atLimit = `${prefix}${"a".repeat(SVG_MAX_BYTES - prefix.length - suffix.length)}${suffix}`;
    const overLimit = `${atLimit}a`;

    expect(utf8ByteLength(atLimit)).toBe(SVG_MAX_BYTES);
    expect(sanitizeSvg(atLimit, size)).toMatch(/<text/i);
    expect(utf8ByteLength(overLimit)).toBe(SVG_MAX_BYTES + 1);
    expect(sanitizeSvg(overLimit, size)).toBe("");
  });

  it("returns a safe empty result for non-SVG or malformed input without throwing", () => {
    expect(() => sanitizeSvg("not svg", size)).not.toThrow();
    expect(() => sanitizeSvg("<svg><rect>", size)).not.toThrow();
    expect(sanitizeSvg("not svg", size)).toMatch(/^$|^<svg\b/i);
    expect(sanitizeSvg("<svg><rect>", size)).toMatch(/^$|^<svg\b/i);
  });
});

describe("buildPartialSvgDraft", () => {
  const draftSize = { width: 800, height: 450 };

  it("auto-closes a truncated stream into a renderable svg", () => {
    const partial = `<svg viewBox="0 0 800 450"><g><rect x="0" y="0" width="100" height="50" fill="#aaa"/><circle cx="20" cy="20" r="1`;
    const out = buildPartialSvgDraft(partial, draftSize);
    expect(out).toBeTruthy();
    // 写了一半的 <circle ...r="1 残片被丢弃
    expect(out).not.toContain("r=\"1");
    expect(out).toContain("<rect");
    expect(out!.trim()).toMatch(/<\/svg>\s*$/i);
    // 未闭合的 <g> 被补上
    expect(out).toContain("</g>");
  });

  it("strips dangerous surface from a partial stream (script/onload/href/external url)", () => {
    const partial = `\`\`\`svg\n<svg onload="x()"><script>evil()</script><a href="javascript:1"><rect fill="url(http://evil/x)" width="5" height="5"/></a>`;
    const out = buildPartialSvgDraft(partial, draftSize);
    expect(out).toBeTruthy();
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/url\(\s*['"]?https?:/i);
    // 剥掉 <a> 标签后仍保留可见 rect
    expect(out).toContain("<rect");
  });

  it("returns null when there is no <svg yet and never throws on junk", () => {
    expect(buildPartialSvgDraft("好的，我来生成", draftSize)).toBeNull();
    expect(buildPartialSvgDraft("", draftSize)).toBeNull();
    expect(() => buildPartialSvgDraft("<svg><<<", draftSize)).not.toThrow();
  });

  it("forces viewBox/xmlns and drops width/height attrs on the root", () => {
    const out = buildPartialSvgDraft(`<svg width="800" height="450"><rect width="5" height="5"/></svg>`, draftSize);
    expect(out).toBeTruthy();
    expect(out).toContain("viewBox=");
    expect(out).toMatch(/xmlns=/);
    expect(out).not.toMatch(/<svg[^>]*\swidth=/i);
  });

  it("丢弃属性里含 '>' 的半截残片标签(quote-aware,不被 lastIndexOf 漏裁)", () => {
    const partial = `<svg viewBox="0 0 800 450"><rect width="5" height="5" fill="#aaa"/><path d="M0 > 0 L10 10`;
    const out = buildPartialSvgDraft(partial, draftSize);
    expect(out).toBeTruthy();
    // 含 '>' 的半截 <path 残片被整段丢弃,不残留破碎属性
    expect(out).not.toContain("M0 > 0");
    expect(out).not.toContain("<path");
    expect(out).toContain("<rect");
    expect(out!.trim()).toMatch(/<\/svg>\s*$/i);
  });

  it("删【外链】url() 与 style,但【本地 url(#id) 渐变保留】(否则 fill 丢失→草稿落黑)", () => {
    const partial = `<svg viewBox="0 0 800 450"><defs><linearGradient id="sky"><stop offset="0" stop-color="#88c"/></linearGradient></defs><rect width="800" height="300" fill="url(#sky)"/><circle r="5" fill="url(&#x68;ttps://evil/x)"/><ellipse rx="5" style="fill:url(https://evil/y)"/></svg>`;
    const out = buildPartialSvgDraft(partial, draftSize);
    expect(out).toBeTruthy();
    // 本地渐变定义与本地引用都保留 → 天空 rect 有正确填充,不会回落黑色
    expect(out).toContain("<linearGradient");
    expect(out).toMatch(/fill="url\(#sky\)"/);
    // 外链(含实体形态)与 style 仍删除
    expect(out).not.toMatch(/evil/i);
    expect(out).not.toMatch(/url\(\s*['"]?h/i);
    expect(out).not.toMatch(/\bstyle\s*=/i);
    expect(out).toContain("<rect");
  });
});

// 导出内联加固:保真黑名单——剔除可执行面,保留 mermaid 可视元素。回归 codex 端到端发现的 blocker:
// 带 viewBox 的恶意 SVG(过 isRenderableSvg 尺寸门)曾被原样内联进导出 HTML。
describe("hardenInlineSvg", () => {
  // 真实 mermaid SVG 一定声明 xmlns:xlink(箭头 marker 用 xlink:href),测试输入对齐之。
  const wrap = (inner: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 120 60">${inner}</svg>`;

  it("移除 <script> 元素", () => {
    const out = hardenInlineSvg(wrap(`<script>alert(1)</script><rect width="10" height="10"/>`));
    expect(out).not.toMatch(/<script/i);
    expect(out).toMatch(/<rect/i);
  });

  it("移除 on* 事件属性", () => {
    const out = hardenInlineSvg(wrap(`<rect width="10" height="10" onload="alert(1)" onclick="x()"/>`));
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).toMatch(/<rect/i);
  });

  it("移除 javascript: 与外链 href/src,保留本地 #引用(mermaid 箭头 marker)", () => {
    const out = hardenInlineSvg(
      wrap(
        `<a href="javascript:alert(1)"><text>x</text></a>` +
          `<image href="https://evil.example/x.png"/>` +
          `<line x1="0" y1="0" x2="9" y2="9" marker-end="url(#arrow)"/>` +
          `<path d="M0 0" xlink:href="#frag"/>`,
      ),
    );
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toContain("https://evil.example");
    // 本地 #引用保留
    expect(out).toContain("#frag");
  });

  it("移除 <iframe>/<object>/<embed> 等活动内容元素", () => {
    const out = hardenInlineSvg(wrap(`<foreignObject><iframe src="https://evil"></iframe><object data="x"></object></foreignObject>`));
    expect(out).not.toMatch(/<iframe/i);
    expect(out).not.toMatch(/<object/i);
  });

  it("剔除 foreignObject 内嵌脚本但保留容器与文本", () => {
    const out = hardenInlineSvg(wrap(`<foreignObject><div>标签文字<script>steal()</script></div></foreignObject>`));
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/steal/);
    expect(out).toContain("标签文字");
  });

  it("清掉 <style> 里的 @import / 外部 url(),保留主题样式块本身", () => {
    const out = hardenInlineSvg(wrap(`<style>@import url(https://evil/x.css); .a{fill:#efe3cc}</style><rect/>`));
    expect(out).not.toMatch(/@import/i);
    expect(out).not.toContain("evil");
  });

  it("保留合法 mermaid 风格 SVG 的可视元素(style 颜色 / marker / 渐变 / 文本)", () => {
    const legit = wrap(
      `<defs><marker id="arrow"><path d="M0,0 L6,3 L0,6 Z" fill="#9c8552"/></marker>` +
        `<linearGradient id="g"><stop offset="0" stop-color="#efe3cc"/></linearGradient></defs>` +
        `<style>.node{fill:#efe3cc;stroke:#b08a3e}</style>` +
        `<rect class="node" width="120" height="48" rx="8"/>` +
        `<text x="10" y="20" font-size="14">需求挖掘</text>`,
    );
    const out = hardenInlineSvg(legit);
    expect(out).toBeTruthy();
    expect(out).toMatch(/<marker/i);
    expect(out).toMatch(/linearGradient/i);
    expect(out).toContain("#efe3cc");
    expect(out).toContain("需求挖掘");
    expect(out).toMatch(/viewBox/i);
  });

  it("拒绝 DOCTYPE/ENTITY(XXE)与解析失败 → 返回 null", () => {
    expect(hardenInlineSvg(`<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 1 1"><rect/></svg>`)).toBeNull();
    expect(hardenInlineSvg("not svg at all")).toBeNull();
    expect(hardenInlineSvg("")).toBeNull();
  });
});
