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
          cells: "<td>新增，A。</td>",
        },
        {
          action: "insertTableColumn",
          ref: "table-a",
          at: "after",
          columnIndex: 1,
          cells: "<th>列C</th>",
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

  it("rejects legacy object structural payloads", () => {
    const parsed = editDraftInputSchema.safeParse({
      ops: [{
        action: "replaceBlock",
        ref: "block-a",
        block: { type: "paragraph", runs: [{ text: "旧对象载体" }] },
      }],
    });

    expect(parsed.success).toBe(false);
  });
});
