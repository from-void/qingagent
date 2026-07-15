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

  it("批注标记复用 text chip 协议并携带完整模型指令", () => {
    expect(toContractChip({
      kind: "annotation",
      label: "批注·履历时间与素材不符",
      text: "按批注修改:「2025年入职」——改为2024年（原因:履历原文为2024年）",
    })).toEqual({
      kind: { kind: "text" },
      resourceRef: null,
      prefix: null,
      label: "批注·履历时间与素材不符",
      suffix: null,
      text: "按批注修改:「2025年入职」——改为2024年（原因:履历原文为2024年）",
    });
  });
});
