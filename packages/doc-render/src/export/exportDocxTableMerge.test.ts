import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { PmDoc, PmTableCellNode } from "@qingagent/pm-schema";
import { toDocx } from "./toDocx.js";

function cell(
  blockId: string,
  text: string,
  attrs: PmTableCellNode["attrs"] = {},
): PmTableCellNode {
  return {
    type: "tableCell",
    attrs,
    content: [{
      type: "paragraph",
      attrs: { blockId: `${blockId}-paragraph` },
      content: [{ type: "text", text }],
    }],
  };
}

describe("DOCX 表格合并导出", () => {
  it("保留 colspan，并为 rowspan 补齐后续行 continuation 单元格", async () => {
    const doc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "table",
        attrs: { blockId: "table" },
        content: [
          {
            type: "tableRow",
            content: [
              cell("a", "A", { rowspan: 2 }),
              cell("b", "B", { colspan: 2 }),
            ],
          },
          {
            type: "tableRow",
            content: [
              cell("c", "C"),
              cell("d", "D"),
            ],
          },
        ],
      }],
    };

    const zip = await JSZip.loadAsync(await toDocx(doc));
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const rows = documentXml?.match(/<w:tr>[\s\S]*?<\/w:tr>/g) ?? [];

    expect(documentXml).toContain('<w:gridSpan w:val="2"/>');
    expect(documentXml).toContain('<w:vMerge w:val="restart"/>');
    expect(documentXml).toContain('<w:vMerge w:val="continue"/>');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.match(/<w:tc>/g)).toHaveLength(3);
    expect(rows[1]).toMatch(/<w:vMerge w:val="continue"\/>[\s\S]*?<w:t[^>]*>C<\/w:t>[\s\S]*?<w:t[^>]*>D<\/w:t>/);
  });
});
