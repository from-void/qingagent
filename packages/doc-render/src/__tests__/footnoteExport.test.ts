import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import { toDocx, toHtml, toMarkdown, toTxt } from "../export/index.js";

const footnoteDoc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "p1" },
      content: [
        { type: "text", text: "第一处" },
        { type: "footnoteReference", attrs: { id: "source_a", note: "来源甲 [第 12 页]" } },
        { type: "text", text: "，重复引用" },
        { type: "footnoteReference", attrs: { id: "source_a", note: "来源甲 [第 12 页]" } },
      ],
    },
    {
      type: "orderedList",
      attrs: { blockId: "ol", start: 1 },
      content: [{
        type: "listItem",
        attrs: { blockId: "li" },
        content: [{
          type: "paragraph",
          attrs: { blockId: "lip" },
          content: [
            { type: "text", text: "列表脚注" },
            { type: "footnoteReference", attrs: { id: "source_b", note: "来源乙 <安全>" } },
          ],
        }],
      }],
    },
    {
      type: "table",
      attrs: { blockId: "table" },
      content: [{
        type: "tableRow",
        content: [{
          type: "tableCell",
          attrs: {},
          content: [{
            type: "paragraph",
            attrs: { blockId: "cell-p" },
            content: [
              { type: "text", text: "表格重复引用" },
              { type: "footnoteReference", attrs: { id: "source_b", note: "来源乙 <安全>" } },
            ],
          }],
        }],
      }],
    },
  ],
};

describe("脚注五种导出中的四个纯函数出口", () => {
  it("Markdown 输出引用与去重定义，并保留稳定 id", () => {
    const markdown = toMarkdown(footnoteDoc);
    expect(markdown.match(/\[\^source_a\]/g)).toHaveLength(3);
    expect(markdown.match(/\[\^source_b\]/g)).toHaveLength(3);
    expect(markdown.match(/^\[\^source_a\]:/gm)).toHaveLength(1);
    expect(markdown.match(/^\[\^source_b\]:/gm)).toHaveLength(1);
    expect(markdown).toContain("来源甲");
    expect(markdown).toContain("来源乙");
  });

  it("HTML 输出语义引用、文末脚注区和每处回链，正文不泄露未转义 note", () => {
    const html = toHtml(footnoteDoc);
    expect(html.match(/role="doc-noteref"/g)).toHaveLength(4);
    expect(html).toContain('role="doc-endnotes"');
    expect(html.match(/role="doc-endnote"/g)).toHaveLength(2);
    expect(html).toContain('id="fn-source_a"');
    expect(html).toContain('href="#fn-source_a"');
    expect(html).toContain('href="#fnref-source_a"');
    expect(html).toContain('href="#fnref-source_a-2"');
    expect(html).toContain("来源乙 &lt;安全&gt;");
    expect(html).not.toContain("来源乙 <安全>");
  });

  it("TXT 输出正文数字引用与文末脚注区", () => {
    const txt = toTxt(footnoteDoc);
    expect(txt).toContain("第一处[1]，重复引用[1]");
    expect(txt).toContain("列表脚注[2]");
    expect(txt).toContain("表格重复引用[2]");
    expect(txt).toContain("\n\n脚注\n[1] 来源甲 [第 12 页]\n[2] 来源乙 <安全>");
  });

  it("DOCX 使用 Word 原生 footnoteReference 和 footnotes.xml", async () => {
    const zip = await new JSZip().loadAsync(await toDocx(footnoteDoc));
    const documentXml = await zip.file("word/document.xml")!.async("string");
    const footnotesXml = await zip.file("word/footnotes.xml")!.async("string");
    const relationshipsXml = await zip.file("word/_rels/document.xml.rels")!.async("string");
    const contentTypesXml = await zip.file("[Content_Types].xml")!.async("string");

    expect(documentXml.match(/<w:footnoteReference w:id="1"\/>/g)).toHaveLength(2);
    expect(documentXml.match(/<w:footnoteReference w:id="2"\/>/g)).toHaveLength(2);
    expect(footnotesXml).toContain('<w:footnote w:id="1">');
    expect(footnotesXml).toContain('<w:footnote w:id="2">');
    expect(footnotesXml).toContain("来源甲 [第 12 页]");
    expect(footnotesXml).toContain("来源乙 &lt;安全&gt;");
    expect(relationshipsXml).toContain(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes",
    );
    expect(contentTypesXml).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
    );
  });
});
