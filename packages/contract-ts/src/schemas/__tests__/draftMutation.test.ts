import { describe, expect, it } from "vitest";
import { editDraftInputSchema } from "../draftMutation";

describe("editDraftInputSchema", () => {
  it("accepts table incremental row/column ops", () => {
    const parsed = editDraftInputSchema.safeParse({
      ops: [
        {
          action: "insertTableRow",
          ref: "table-a",
          at: "end",
          cells: [{ runs: [{ text: "新增，A。" }] }],
        },
        {
          action: "insertTableColumn",
          ref: "table-a",
          at: "after",
          columnIndex: 1,
          cells: [{ runs: [{ text: "列C" }], header: true }],
        },
        { action: "deleteTableRow", ref: "table-a", rowIndex: 2 },
        { action: "deleteTableColumn", ref: "table-a", columnIndex: 0 },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects negative table indexes", () => {
    const parsed = editDraftInputSchema.safeParse({
      ops: [{ action: "deleteTableRow", ref: "table-a", rowIndex: -1 }],
    });

    expect(parsed.success).toBe(false);
  });
});
