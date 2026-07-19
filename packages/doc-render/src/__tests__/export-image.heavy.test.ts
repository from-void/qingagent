import { describe, expect, it } from "vitest";
import type { LegacySection } from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/pm-schema";
import { toDocx, toPdf, toTxt } from "../export/index.js";
import { ensureSvgDimensions, prepareSvgForRasterization } from "../export/rasterize.js";
import { localUploadPath } from "../export/shared.js";
import { pmInlineToDocx } from "../export/toDocx.js";
import { pmInlineToHtml } from "../export/toHtml.js";
import { hasChromium } from "./browserTestGate.js";

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const sections: LegacySection[] = [
  {
    kind: "image",
    data: {
      src: `data:image/png;base64,${png1x1}`,
      alt: "一只猫",
      caption: "图1",
      width: null,
      height: null,
    },
  },
];

describe("LegacySection.image export", () => {
  it("renders text fallback without embedding base64", () => {
    const txt = toTxt(sections);
    expect(txt).toContain("图1");
    expect(txt).not.toContain("iVBOR");
  });

  it("exports DOCX", async () => {
    const docx = await toDocx(sections);
    expect(docx.subarray(0, 2).toString("utf8")).toBe("PK");
    expect(docx.length).toBeGreaterThan(1000);
  });

  it.skipIf(!hasChromium)("exports PDF", async () => {
    const pdf = await toPdf(sections);
    expect(pdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });
});

describe("ensureSvgDimensions (export-docx-image-lost 回归)", () => {
  it("无 width/height 但有 viewBox 时从 viewBox 注入尺寸", () => {
    // 复现:AI 配图 SVG 常无显式尺寸,栅格化时容器塌成 0 → docx 丢图。
    const out = ensureSvgDimensions('<svg viewBox="0 0 800 600"><rect/></svg>');
    expect(out).toMatch(/width="800"/);
    expect(out).toMatch(/height="600"/);
    expect(out).toContain("<rect/></svg>");
  });

  it("已有显式 width/height 时原样返回(如 mermaid)", () => {
    const svg = '<svg width="280" height="972" viewBox="0 0 280 972"><g/></svg>';
    expect(ensureSvgDimensions(svg)).toBe(svg);
  });

  it("只缺其一时只补缺的那个", () => {
    const out = ensureSvgDimensions('<svg width="100" viewBox="0 0 100 50"><g/></svg>');
    expect(out).toMatch(/height="50"/);
    expect((out.match(/width=/g) ?? []).length).toBe(1);
  });

  it("无 viewBox 也无尺寸时原样返回(无从推断,不乱注入)", () => {
    const svg = "<svg><g/></svg>";
    expect(ensureSvgDimensions(svg)).toBe(svg);
  });

  it("viewBox 尺寸非正时不注入", () => {
    const svg = '<svg viewBox="0 0 0 0"><g/></svg>';
    expect(ensureSvgDimensions(svg)).toBe(svg);
  });
});

describe("SVG rasterization input hardening", () => {
  it("base64 data URL 走统一解码并在栅格化前净化", () => {
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" onload="steal()"><script>steal()</script><rect width="40" height="20"/></svg>';
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(raw, "utf8").toString("base64")}`;
    const safe = prepareSvgForRasterization(dataUrl);

    expect(safe).not.toBeNull();
    expect(safe).not.toMatch(/<script/i);
    expect(safe).not.toMatch(/onload/i);
    expect(safe).toMatch(/<rect/i);
    expect(safe).toMatch(/width="40"/i);
    expect(safe).toMatch(/height="20"/i);
  });

  it("畸形、XXE 与非 SVG 输入 fail-closed", () => {
    expect(prepareSvgForRasterization("<svg><g></svg>")).toBeNull();
    expect(prepareSvgForRasterization('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>')).toBeNull();
    expect(prepareSvgForRasterization("<html></html>")).toBeNull();
    expect(prepareSvgForRasterization("data:image/svg+xml,%E0%A4%A")).toBeNull();
  });
});

describe("DOCX SVG data URL", () => {
  it.skipIf(!hasChromium)("支持 base64 SVG 并导出为 PNG 图片", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><text x="1" y="15">中文</text></svg>';
    const docx = await toDocx([{
      kind: "image",
      data: {
        src: `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`,
        alt: "base64 svg",
        caption: null,
        width: 40,
        height: 20,
      },
    }]);
    expect(docx.subarray(0, 2).toString("utf8")).toBe("PK");
    expect(docx.length).toBeGreaterThan(1_000);
  });
});

describe("PM export", () => {
  const pmDoc: PmDoc = {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "heading",
        attrs: { blockId: "h-1", level: 1, textAlign: "center" },
        content: [{ type: "text", text: "标题" }],
      },
      {
        type: "paragraph",
        attrs: { blockId: "p-1" },
        content: [
          { type: "text", text: "加粗", marks: [{ type: "bold" }] },
          { type: "text", text: "链接", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
          { type: "text", text: "代码", marks: [{ type: "code" }] },
          { type: "text", text: "高亮", marks: [{ type: "highlight", attrs: { color: "yellow" } }] },
        ],
      },
    ],
  };

  it("renders TXT from PM canonical plain text", () => {
    expect(toTxt(pmDoc)).toBe("标题\n\n加粗链接代码高亮");
  });

  it("maps PM inline marks for HTML + DOCX export renderers", () => {
    const inline = [
      {
        type: "text" as const,
        text: "全部格式",
        marks: [
          { type: "bold" as const },
          { type: "italic" as const },
          { type: "underline" as const },
          { type: "strike" as const },
          { type: "code" as const },
          { type: "highlight" as const, attrs: { color: "yellow" as const } },
          { type: "link" as const, attrs: { href: "https://example.com" } },
        ],
      },
    ];

    const html = pmInlineToHtml(inline);
    expect(html).toContain("全部格式");
    expect(html).toContain("<strong>");
    expect(html).toContain("<em>");
    expect(html).toContain("<u>");
    expect(html).toContain("<s>");
    expect(html).toContain('<code class="inline-code">');
    expect(html).toContain('<mark data-color="yellow">');
    expect(html).toContain('<a href="https://example.com">');

    const docx = pmInlineToDocx(inline);
    expect(docx.length).toBe(1);
    expect(docx[0]?.constructor.name).toBe("ExternalHyperlink");
  });

  it("keeps only http(s) protocols as HTML links", () => {
    const html = pmInlineToHtml([
      { type: "text", text: "https", marks: [{ type: "link", attrs: { href: "https://example.com/a" } }] },
      { type: "text", text: "http", marks: [{ type: "link", attrs: { href: "http://example.com/b" } }] },
      { type: "text", text: "js", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
      { type: "text", text: "data", marks: [{ type: "link", attrs: { href: "data:text/html;base64,PGgxPg==" } }] },
    ]);

    expect(html).toContain('<a href="https://example.com/a">https</a>');
    expect(html).toContain('<a href="http://example.com/b">http</a>');
    // 非 http(s) 协议:不渲染成链接,且原始危险 href 不得出现在输出里。
    expect(html).toContain("js");
    expect(html).toContain("data");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("<a href=\"javascript");
    expect(html).not.toContain("<a href=\"data:");
  });

  it("exports DOCX from PM canonical without projecting away marks", async () => {
    const docx = await toDocx(pmDoc);
    expect(docx.subarray(0, 2).toString("utf8")).toBe("PK");
    expect(docx.length).toBeGreaterThan(1000);
  });

  it.skipIf(!hasChromium)("exports PDF from PM canonical without throwing on marks", async () => {
    const pdf = await toPdf(pmDoc);
    expect(pdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });
});

describe("upload src hardening", () => {
  it("rejects path-traversal upload srcs", () => {
    expect(localUploadPath("/api/v1/files/../package.json/illustration.svg")).toBeNull();
    expect(localUploadPath("/api/v1/files/../../etc/passwd/x")).toBeNull();
    expect(localUploadPath("/api/v1/files/12345678-1234-1234-1234-123456789abc/../package.json")).toBeNull();
    expect(localUploadPath("/api/v1/files/not-a-uuid/illustration.svg")).toBeNull();
    expect(localUploadPath("/api/v1/files/12345678-1234-1234-1234-123456789abc/..%2F..")).toBeNull();
    expect(localUploadPath("/api/v1/files/12345678-1234-1234-1234-123456789abc/%00.png")).toBeNull();
    expect(localUploadPath("/api/v1/files/12345678-1234-1234-1234-123456789abc/%E6%B5%8B%E8%AF%95%ZZ.png")).toBeNull();
  });

  it("accepts a well-formed uuid upload src inside uploads dir", () => {
    const p = localUploadPath("/api/v1/files/12345678-1234-1234-1234-123456789abc/illustration.svg");
    expect(p).not.toBeNull();
    expect(p!.replace(/\\/g, "/")).toMatch(/\/uploads\/12345678-1234-1234-1234-123456789abc\/illustration\.svg$/);
  });

  it.each([
    ["纯英文名", "illustration.svg", "illustration.svg"],
    ["中文名", "%E6%B5%8B%E8%AF%95.svg", "测试.svg"],
    ["空格名", "my%20photo.svg", "my photo.svg"],
  ])("accepts %s after decoding the final segment once", (_case, encoded, decoded) => {
    const p = localUploadPath(`/api/v1/files/12345678-1234-1234-1234-123456789abc/${encoded}`);
    expect(p).not.toBeNull();
    expect(p!.replace(/\\/g, "/")).toMatch(new RegExp(`/uploads/12345678-1234-1234-1234-123456789abc/${decoded.replace(".", "\\.")}$`));
  });
});
