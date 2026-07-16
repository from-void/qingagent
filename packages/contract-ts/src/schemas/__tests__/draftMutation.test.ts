import { describe, expect, it } from "vitest";
import { DRAFT_MARK_COLORS } from "../../DraftMutation";
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

  it("accepts every supported markText mark", () => {
    const marks = [
      { type: "bold" },
      { type: "italic" },
      { type: "underline" },
      { type: "strike" },
      { type: "strikeThrough" },
      { type: "code" },
      { type: "link", href: "https://example.com", title: "示例" },
    ];

    for (const mark of marks) {
      expect(editDraftInputSchema.safeParse({
        ops: [{ action: "markText", find: "目标文本", mark, op: "add" }],
      }).success).toBe(true);
    }

    for (const color of DRAFT_MARK_COLORS) {
      for (const type of ["textColor", "highlight"] as const) {
        expect(editDraftInputSchema.safeParse({
          ops: [{ action: "markText", find: "目标文本", mark: { type, color }, op: "add" }],
        }).success).toBe(true);
      }
    }
  });

  it("rejects unknown, malformed, or surplus markText payloads", () => {
    const invalidMarks = [
      { type: "math" },
      { type: "bold", href: "https://example.com" },
      { type: "link", href: 42 },
      { type: "textColor", color: "not-a-theme-color" },
      { type: "highlight" },
    ];

    for (const mark of invalidMarks) {
      expect(editDraftInputSchema.safeParse({
        ops: [{ action: "markText", find: "目标文本", mark, op: "add" }],
      }).success).toBe(false);
    }
  });
});
