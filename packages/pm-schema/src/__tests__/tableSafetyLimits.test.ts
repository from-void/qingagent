import { describe, expect, it } from "vitest";
import {
  PM_TABLE_MAX_CELLS,
  PM_TABLE_MAX_LOGICAL_COLUMNS,
  PM_TABLE_MAX_SPAN,
  safeParsePmDoc,
} from "../validators";

function cell(id: string, attrs: Record<string, unknown> = {}) {
  return {
    type: "tableCell",
    attrs,
    content: [{ type: "paragraph", attrs: { blockId: id }, content: [] }],
  };
}

function docWithRows(rows: unknown[]) {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{ type: "table", attrs: { blockId: "table" }, content: rows }],
  };
}

describe("PM table safety limits", () => {
  it("拒绝超上限的单个 colspan/rowspan", () => {
    for (const attrs of [
      { colspan: PM_TABLE_MAX_SPAN + 1 },
      { rowspan: PM_TABLE_MAX_SPAN + 1 },
    ]) {
      const result = safeParsePmDoc(docWithRows([
        { type: "tableRow", content: [cell("p", attrs)] },
      ]));
      expect(result.success).toBe(false);
    }
  });

  it("拒绝单行超上限的逻辑列数", () => {
    const half = Math.floor(PM_TABLE_MAX_LOGICAL_COLUMNS / 2) + 1;
    const result = safeParsePmDoc(docWithRows([
      { type: "tableRow", content: [cell("a", { colspan: half }), cell("b", { colspan: half })] },
    ]));
    expect(result.success).toBe(false);
  });

  it("拒绝跨行累计超过上限的总单元格数", () => {
    const cellsPerRow = Math.min(PM_TABLE_MAX_LOGICAL_COLUMNS, 1_000);
    const rowCount = Math.floor(PM_TABLE_MAX_CELLS / cellsPerRow) + 1;
    const rows = Array.from({ length: rowCount }, (_, rowIndex) => ({
      type: "tableRow",
      content: Array.from({ length: cellsPerRow }, (_, cellIndex) => cell(`p-${rowIndex}-${cellIndex}`)),
    }));
    expect(rows.reduce((sum, row) => sum + row.content.length, 0)).toBeGreaterThan(PM_TABLE_MAX_CELLS);
    expect(safeParsePmDoc(docWithRows(rows)).success).toBe(false);
  });
});
