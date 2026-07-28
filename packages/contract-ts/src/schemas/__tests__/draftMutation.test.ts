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

  it.each([
    ["block before + ref", {
      action: "insertBlock",
      position: "before",
      ref: "block-a",
      blocks: "<p>新增</p>",
    }],
    ["block start 无 ref", {
      action: "insertBlock",
      position: "start",
      blocks: "<p>新增</p>",
    }],
    ["list after + ref", {
      action: "insertListItem",
      parentRef: "list-a",
      at: "after",
      ref: "item-a",
      item: "<li>新增</li>",
    }],
    ["list end 无 ref", {
      action: "insertListItem",
      parentRef: "list-a",
      at: "end",
      item: "<li>新增</li>",
    }],
    ["table row before + index", {
      action: "insertTableRow",
      ref: "table-a",
      at: "before",
      rowIndex: 0,
      cells: "<td>新增</td>",
    }],
    ["table row end 无 index", {
      action: "insertTableRow",
      ref: "table-a",
      at: "end",
      cells: "<td>新增</td>",
    }],
    ["table column after + index", {
      action: "insertTableColumn",
      ref: "table-a",
      at: "after",
      columnIndex: 0,
      cells: "<td>新增</td>",
    }],
    ["table column end 无 index", {
      action: "insertTableColumn",
      ref: "table-a",
      at: "end",
      cells: "<td>新增</td>",
    }],
  ])("accepts position fields with exact relation: %s", (_label, op) => {
    expect(editDraftInputSchema.safeParse({ ops: [op] }).success).toBe(true);
  });

  it.each([
    ["block before 缺 ref", {
      action: "insertBlock",
      position: "before",
      blocks: "<p>新增</p>",
    }],
    ["block after 缺 ref", {
      action: "insertBlock",
      position: "after",
      blocks: "<p>新增</p>",
    }],
    ["block start 多余 ref", {
      action: "insertBlock",
      position: "start",
      ref: "block-a",
      blocks: "<p>新增</p>",
    }],
    ["block end 多余 ref", {
      action: "insertBlock",
      position: "end",
      ref: "block-a",
      blocks: "<p>新增</p>",
    }],
    ["list before 缺 ref", {
      action: "insertListItem",
      parentRef: "list-a",
      at: "before",
      item: "<li>新增</li>",
    }],
    ["list after 缺 ref", {
      action: "insertListItem",
      parentRef: "list-a",
      at: "after",
      item: "<li>新增</li>",
    }],
    ["list start 多余 ref", {
      action: "insertListItem",
      parentRef: "list-a",
      at: "start",
      ref: "item-a",
      item: "<li>新增</li>",
    }],
    ["list end 多余 ref", {
      action: "insertListItem",
      parentRef: "list-a",
      at: "end",
      ref: "item-a",
      item: "<li>新增</li>",
    }],
    ["table row before 缺 index", {
      action: "insertTableRow",
      ref: "table-a",
      at: "before",
      cells: "<td>新增</td>",
    }],
    ["table row after 缺 index", {
      action: "insertTableRow",
      ref: "table-a",
      at: "after",
      cells: "<td>新增</td>",
    }],
    ["table row end 多余 index", {
      action: "insertTableRow",
      ref: "table-a",
      at: "end",
      rowIndex: 1,
      cells: "<td>新增</td>",
    }],
    ["table column before 缺 index", {
      action: "insertTableColumn",
      ref: "table-a",
      at: "before",
      cells: "<td>新增</td>",
    }],
    ["table column after 缺 index", {
      action: "insertTableColumn",
      ref: "table-a",
      at: "after",
      cells: "<td>新增</td>",
    }],
    ["table column end 多余 index", {
      action: "insertTableColumn",
      ref: "table-a",
      at: "end",
      columnIndex: 1,
      cells: "<td>新增</td>",
    }],
  ])("rejects inconsistent position fields before execution: %s", (_label, op) => {
    expect(editDraftInputSchema.safeParse({ ops: [op] }).success).toBe(false);
  });

  it.each([
    ["block 空串", {
      action: "insertBlock",
      position: "before",
      ref: "",
      blocks: "<p>新增</p>",
    }],
    ["block 空白", {
      action: "insertBlock",
      position: "after",
      ref: " \n\t ",
      blocks: "<p>新增</p>",
    }],
    ["block 零宽", {
      action: "insertBlock",
      position: "before",
      ref: "\u200B\u2060",
      blocks: "<p>新增</p>",
    }],
    ["list 空串", {
      action: "insertListItem",
      parentRef: "list-a",
      at: "before",
      ref: "",
      item: "<li>新增</li>",
    }],
    ["list 空白", {
      action: "insertListItem",
      parentRef: "list-a",
      at: "after",
      ref: "  ",
      item: "<li>新增</li>",
    }],
    ["list 零宽", {
      action: "insertListItem",
      parentRef: "list-a",
      at: "before",
      ref: "\u200B",
      item: "<li>新增</li>",
    }],
  ])("rejects blank positional ref before execution: %s", (_label, op) => {
    expect(editDraftInputSchema.safeParse({ ops: [op] }).success).toBe(false);
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

  it("aligns link href validation with pm-schema security rules", () => {
    const parseHref = (href: string) => editDraftInputSchema.safeParse({
      ops: [{ action: "markText", find: "目标文本", mark: { type: "link", href }, op: "add" }],
    });

    for (const href of ["//evil.example/path", "/\njavascript:alert(1)"]) {
      expect(parseHref(href).success, href).toBe(false);
    }

    for (const href of ["HTTPS://example.com", "  https://example.com/path  "]) {
      expect(parseHref(href).success, href).toBe(true);
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
