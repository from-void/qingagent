import { describe, expect, it } from "vitest";
import type { ViewBlock } from "./protocol";
import { cloneViewSections } from "./cloneViewDoc";

describe("cloneViewSections", () => {
  it("递归保留列表 rowDiff.childLists，且深层 spans 独立克隆", () => {
    const section = {
      kind: "list",
      ordered: false,
      items: ["父项"],
      rowDiff: [{
        status: "same",
        spans: [{ kind: "text", text: "父项" }],
        childLists: [{
          beforeListIndex: 0,
          afterListIndex: 0,
          rowDiff: [{
            status: "changed",
            oldText: "旧叶子",
            spans: [{ kind: "patchIns", text: "新叶子", patchId: "clone-view-nested" }],
          }],
        }],
      }],
    } satisfies ViewBlock;

    const cloned = cloneViewSections([section])[0];
    expect(cloned).toEqual(section);
    expect(cloned).not.toBe(section);
    if (cloned?.kind !== "list") throw new Error("fixture 应克隆为 list");
    expect(cloned.rowDiff).not.toBe(section.rowDiff);
    expect(cloned.rowDiff?.[0]!.childLists).not.toBe(section.rowDiff[0]!.childLists);
    expect(cloned.rowDiff?.[0]!.childLists?.[0]!.rowDiff).not.toBe(section.rowDiff[0]!.childLists?.[0]!.rowDiff);
    const clonedLeaf = cloned.rowDiff?.[0]!.childLists?.[0]!.rowDiff[0];
    const sourceLeaf = section.rowDiff[0]!.childLists?.[0]!.rowDiff[0];
    expect(clonedLeaf && "spans" in clonedLeaf ? clonedLeaf.spans : undefined)
      .not.toBe(sourceLeaf && "spans" in sourceLeaf ? sourceLeaf.spans : undefined);
  });
});
