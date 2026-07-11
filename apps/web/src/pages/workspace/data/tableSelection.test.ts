// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createTableAiModifyTarget,
  normalizeTableSelection,
  tableAiModifyDisabledReason,
  tableHasMergedCells,
} from "./tableSelection";

const rows = [
  ["A1", "B1", "C1"],
  ["A2", "B2", "C2"],
  ["A3", "B3", "C3"],
];

describe("tableSelection", () => {
  it("将反向拖选归一化为 0-based inclusive 范围", () => {
    expect(normalizeTableSelection("column", [2, 0])).toEqual({
      axis: "column",
      startIndex: 0,
      endIndex: 2,
    });
  });

  it("行选按列序用竖线拼接，多行换行且数据不截断", () => {
    const longText = "长".repeat(180);
    const target = createTableAiModifyTarget({
      blockId: "table-1",
      rows: [["A1", longText], ["A2", "B2"]],
      axis: "row",
      range: [1, 0],
    });
    expect(target.label).toBe(`A1 | ${longText}\nA2 | B2`);
    expect(target.label).toContain(longText);
    expect(target.suffix).toBe("表格·第1–2行");
    expect(target.tableSelection).toMatchObject({ axis: "row", startIndex: 0, endIndex: 1 });
    expect(target.tableSelection?.signature).toMatch(/^fnv1a-[0-9a-f]{8}$/);
  });

  it("列选按物理行列顺序逐 cell 换行，不再空格平铺", () => {
    const target = createTableAiModifyTarget({
      blockId: "table-1",
      rows,
      axis: "column",
      range: [2, 1],
    });
    expect(target.label).toBe("B1\nC1\nB2\nC2\nB3\nC3");
    expect(target.suffix).toBe("表格·第2–3列");
    expect(target.tableSelection).toMatchObject({ axis: "column", startIndex: 1, endIndex: 2 });
  });

  it("识别 colspan/rowspan 合并单元格", () => {
    const table = document.createElement("table");
    table.innerHTML = "<tbody><tr><td>A</td><td>B</td></tr></tbody>";
    expect(tableHasMergedCells(table)).toBe(false);
    table.rows[0]!.cells[0]!.colSpan = 2;
    expect(tableHasMergedCells(table)).toBe(true);
    table.rows[0]!.cells[0]!.colSpan = 1;
    table.rows[0]!.cells[1]!.rowSpan = 2;
    expect(tableHasMergedCells(table)).toBe(true);
    expect(tableAiModifyDisabledReason(table)).toBe("含合并单元格的表格暂不支持");
  });
});
