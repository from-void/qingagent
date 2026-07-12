import { describe, expect, it } from "vitest";
import { flattenNestedTablesInCells } from "../repairNestedTables";
import { safeParsePmDoc } from "../validators";
import type { PmDoc } from "../types";

describe("flattenNestedTablesInCells", () => {
  it("存量嵌套表降级成逐行 TSV 段落且不丢文本", () => {
    const legacy = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "table",
        attrs: { blockId: "outer" },
        content: [{
          type: "tableRow",
          content: [{
            type: "tableCell",
            content: [{
              type: "table",
              attrs: { blockId: "inner" },
              content: [
                { type: "tableRow", content: [cell("A"), cell("B")] },
                { type: "tableRow", content: [cell("C"), cell("D")] },
              ],
            }],
          }],
        }],
      }],
    } as unknown as PmDoc;

    const repaired = flattenNestedTablesInCells(legacy);
    const outerCell = repaired.content[0]?.type === "table" ? repaired.content[0].content[0]?.content[0] : null;
    expect(outerCell?.content.map((block) => {
      const inline = block.type === "paragraph" ? block.content?.[0] : null;
      return inline?.type === "text" ? inline.text : "";
    })).toEqual(["A\tB", "C\tD"]);
    expect(JSON.stringify(repaired).match(/\"type\":\"table\"/g)).toHaveLength(1);
    expect(safeParsePmDoc(repaired).success).toBe(true);
  });
});

function cell(text: string) {
  return {
    type: "tableCell",
    content: [{ type: "paragraph", attrs: { blockId: `p-${text}` }, content: [{ type: "text", text }] }],
  };
}
