import { describe, expect, it } from "vitest";
import type { PmDoc } from "../types";
import { pmTableSelectionCellTexts } from "../tableSelection";

const doc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [{
    type: "table",
    attrs: { blockId: "table-1" },
    content: [
      {
        type: "tableRow",
        content: [
          { type: "tableCell", content: [{ type: "paragraph", attrs: { blockId: "p-a1" }, content: [{ type: "text", text: "A1" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", attrs: { blockId: "p-b1" }, content: [{ type: "text", text: "B1" }] }] },
        ],
      },
      {
        type: "tableRow",
        content: [
          { type: "tableCell", content: [{ type: "paragraph", attrs: { blockId: "p-a2" }, content: [{ type: "text", text: "A2" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", attrs: { blockId: "p-b2" }, content: [{ type: "text", text: "B2" }] }] },
        ],
      },
    ],
  }],
};

describe("pmTableSelectionCellTexts", () => {
  it("按物理行列顺序抽取行/列选区纯文本", () => {
    expect(pmTableSelectionCellTexts(doc, "table-1", { axis: "row", startIndex: 1, endIndex: 1 }))
      .toEqual(["A2", "B2"]);
    expect(pmTableSelectionCellTexts(doc, "table-1", { axis: "column", startIndex: 1, endIndex: 1 }))
      .toEqual(["B1", "B2"]);
  });

  it("表或范围不存在时 fail closed", () => {
    expect(pmTableSelectionCellTexts(doc, "missing", { axis: "row", startIndex: 0, endIndex: 0 })).toBeNull();
    expect(pmTableSelectionCellTexts(doc, "table-1", { axis: "column", startIndex: 2, endIndex: 2 })).toBeNull();
  });
});
