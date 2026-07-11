import { describe, expect, it } from "vitest";
import { toContractChip } from "./sessionFrameGuards";

describe("toContractChip", () => {
  it("透传表格选区到乐观气泡与 wire 共用的 contract chip", () => {
    const tableSelection = {
      axis: "row" as const,
      startIndex: 0,
      endIndex: 1,
      signature: "fnv1a-deadbeef",
    };
    expect(toContractChip({
      kind: "sel",
      label: "甲 | 乙",
      suffix: "表格·第1–2行",
      blockId: "table-1",
      tableSelection,
    })).toMatchObject({
      kind: { kind: "selection" },
      resourceRef: { id: "table-1", domain: { kind: "docSpan" } },
      tableSelection,
    });
  });
});
