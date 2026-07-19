import { describe, expect, it } from "vitest";
import { tableSelectionTextSignature } from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/pm-schema";
import type { ChatInputSnapshot } from "./chatInputTypes";
import { staleTableSelectionChipIndices } from "./tableSelectionFreshness";

function tableDoc(text = "A1"): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "table",
      attrs: { blockId: "table-1" },
      content: [{
        type: "tableRow",
        content: [{
          type: "tableCell",
          content: [{ type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text }] }],
        }],
      }],
    }],
  };
}

function snapshot(signature?: string): Pick<ChatInputSnapshot, "chips"> {
  return {
    chips: [{
      kind: "sel",
      label: "A1",
      suffix: "表格·第1行",
      blockId: "table-1",
      tableSelection: { axis: "row", startIndex: 0, endIndex: 0, signature },
    }],
  };
}

describe("staleTableSelectionChipIndices", () => {
  it("签名一致时放行，表格文字变化时拒发", () => {
    const original = snapshot(tableSelectionTextSignature(["A1"]));
    expect(staleTableSelectionChipIndices(original, tableDoc())).toEqual([]);
    expect(staleTableSelectionChipIndices(original, tableDoc("已变化"))).toEqual([0]);
  });

  it("缺签名、表缺失或范围越界均 fail closed", () => {
    expect(staleTableSelectionChipIndices(snapshot(), tableDoc())).toEqual([0]);
    expect(staleTableSelectionChipIndices(snapshot("fnv1a-deadbeef"), {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [],
    })).toEqual([0]);
    const outOfRange = snapshot("fnv1a-deadbeef");
    outOfRange.chips[0]!.tableSelection!.endIndex = 2;
    expect(staleTableSelectionChipIndices(outOfRange, tableDoc())).toEqual([0]);
  });
});
