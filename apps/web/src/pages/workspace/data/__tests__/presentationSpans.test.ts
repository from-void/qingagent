import { describe, expect, it } from "vitest";
import type { ViewBlock } from "../protocol";
import { sectionText, splitGraphemes, tableCellEntries, visibleReviewSections } from "../presentationSpans";

describe("presentation text helpers", () => {
  it("splits by grapheme without cutting surrogate pairs", () => {
    expect(splitGraphemes("A😀B")).toEqual(["A", "😀", "B"]);
  });

  it("extracts visible text from supported view block kinds", () => {
    const sections: ViewBlock[] = [
      { kind: "h1", text: "标题" },
      { kind: "p", spans: [{ kind: "text", text: "正文" }] },
      { kind: "table", head: ["A"], rows: [["B"]] },
      { kind: "hr" },
    ];

    expect(sections.map(sectionText)).toEqual(["标题", "正文", "A\nB", ""]);
  });

  it("excludes deleted review blocks", () => {
    const sections: ViewBlock[] = [
      { kind: "p", spans: [{ kind: "text", text: "保留" }] },
      {
        kind: "p",
        spans: [{ kind: "text", text: "删除" }],
        blockPatch: { op: "delete", patchId: "p1" },
      },
    ];

    expect(visibleReviewSections(sections).map(sectionText)).toEqual(["保留"]);
    expect(sectionText(sections[1]!)).toBe("");
  });

  it("按表头、正文的物理 row-major 顺序提取 cell", () => {
    expect(tableCellEntries({
      kind: "table",
      head: ["H1", "H2"],
      rows: [["A", "B"], ["C", "D"]],
    })).toEqual([
      { rowIndex: 0, cellIndex: 0, text: "H1" },
      { rowIndex: 0, cellIndex: 1, text: "H2" },
      { rowIndex: 1, cellIndex: 0, text: "A" },
      { rowIndex: 1, cellIndex: 1, text: "B" },
      { rowIndex: 2, cellIndex: 0, text: "C" },
      { rowIndex: 2, cellIndex: 1, text: "D" },
    ]);
  });

  it("支持空表与仅表头", () => {
    expect(tableCellEntries({ kind: "table", head: [], rows: [] })).toEqual([]);
    expect(tableCellEntries({ kind: "table", head: ["甲", ""], rows: [] })).toEqual([
      { rowIndex: 0, cellIndex: 0, text: "甲" },
      { rowIndex: 0, cellIndex: 1, text: "" },
    ]);
  });
});
