import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import { toDocx } from "./toDocx.js";
import { toHtml } from "./toHtml.js";

const doc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [
    {
      type: "orderedList",
      attrs: { blockId: "ol-upper-roman", start: 1, listStyle: "upper-roman" },
      content: [
        {
          type: "listItem",
          attrs: { blockId: "li-1" },
          content: [{ type: "paragraph", attrs: { blockId: "li-1-p" }, content: [{ type: "text", text: "第一项" }] }],
        },
      ],
    },
  ],
};

describe("export orderedList listStyle", () => {
  it("HTML 导出保留 list-style-type", () => {
    const html = toHtml(doc);

    expect(html).toContain('<ol style="list-style-type:upper-roman" data-list-style="upper-roman">');
  });

  it("DOCX 导出使用对应 numbering format", async () => {
    const buffer = await toDocx(doc);
    const zip = await JSZip.loadAsync(buffer);
    const numberingXml = await zip.file("word/numbering.xml")?.async("string");

    expect(numberingXml).toContain('w:val="upperRoman"');
  });
});
