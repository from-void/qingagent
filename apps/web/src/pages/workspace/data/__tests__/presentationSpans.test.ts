import { describe, expect, it } from "vitest";
import type { ViewBlock } from "../protocol";
import { sectionText, splitGraphemes, visibleReviewSections } from "../presentationSpans";

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
});
