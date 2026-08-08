import { describe, expect, it } from "vitest";
import { pmTableSelectionCellTexts, pmToLegacySections, type PmDoc, type PmTableNode } from "@qingagent/pm-schema";
import { createSession } from "../session/sessionState.js";
import { createSessionScopedTools } from "../session/sessionTools.js";
import { clonePmDoc, validateCurrentTableSelectionScopes, validateTableSelectionScope } from "../doc-engine/draftScratch.js";

const ctx = {} as any;

function tableDoc(): PmDoc {
  return tableDocFromRows([
    ["A1", "B1"],
    ["A2", "B2"],
  ]);
}

function tableDocFromRows(rows: readonly (readonly string[])[]): PmDoc {
  const paragraph = (blockId: string, text: string) => ({
    type: "paragraph" as const,
    attrs: { blockId },
    content: [{ type: "text" as const, text }],
  });
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "table",
      attrs: { blockId: "table-1" },
      content: rows.map((row, rowIndex) => ({
        type: "tableRow",
        content: row.map((text, columnIndex) => ({
          type: "tableCell",
          content: [paragraph(`p-r${rowIndex + 1}-c${columnIndex + 1}`, text)],
        })),
      })),
    }],
  };
}

function bindTableSelection(
  axis: "row" | "column",
  startIndex: number,
  endIndex: number,
) {
  const state = createSession(`scope-${axis}-${startIndex}-${endIndex}`);
  state.doc = tableDoc();
  state.docVersion = 1;
  state._currentChips = [{
    kind: { kind: "selection" },
    resourceRef: { id: "table-1", domain: { kind: "docSpan" } },
    prefix: null,
    label: "表格选区",
    suffix: null,
    tableSelection: { axis, startIndex, endIndex },
  }];
  return state;
}

describe("table selection post-edit scope validator", () => {
  it("未选行内容等价但内部 blockId 被整表重建时放行", () => {
    const before = tableDoc().content[0] as PmTableNode;
    before.content[0]!.content[0]!.content.push({
      type: "bulletList",
      attrs: { blockId: "list-old" },
      content: [{
        type: "listItem",
        attrs: { blockId: "item-old" },
        content: [{
          type: "paragraph",
          attrs: { blockId: "nested-paragraph-old" },
          content: [{ type: "text", text: "嵌套内容" }],
        }],
      }],
    });
    before.content[0]!.content[0]!.content.push({
      type: "diagram",
      attrs: {
        blockId: "diagram-old",
        lang: "mermaid",
        source: "flowchart LR\nA --> B",
        svg: "<svg>旧缓存</svg>",
      },
    });
    const after = clonePmDoc({ type: "doc", attrs: { schemaVersion: 1 }, content: [before] }).content[0] as PmTableNode;
    after.content.forEach((row, rowIndex) => row.content.forEach((cell, columnIndex) => {
      cell.content.forEach((block, blockIndex) => {
        block.attrs = { ...block.attrs, blockId: `table-1-r${rowIndex}-c${columnIndex}-p${blockIndex}` };
      });
    }));
    const nestedList = after.content[0]!.content[0]!.content[1] as any;
    nestedList.content[0].attrs.blockId = "item-new";
    nestedList.content[0].content[0].attrs.blockId = "nested-paragraph-new";
    const diagram = after.content[0]!.content[0]!.content[2] as any;
    diagram.attrs.svg = "<svg>新缓存</svg>";

    expect(validateTableSelectionScope({
      before,
      after,
      tableRef: "table-1",
      selection: { axis: "row", startIndex: 1, endIndex: 1 },
    })).toEqual({ ok: true });
  });

  it.each([
    ["文本", (table: PmTableNode) => {
      (table.content[0]!.content[0]!.content[0] as any).content[0].text = "越界";
    }],
    ["marks", (table: PmTableNode) => {
      (table.content[0]!.content[0]!.content[0] as any).content[0].marks = [{ type: "bold" }];
    }],
    ["backgroundColor", (table: PmTableNode) => {
      table.content[0]!.content[0]!.attrs = { backgroundColor: "amber" };
    }],
    ["colspan", (table: PmTableNode) => {
      table.content[0]!.content[0]!.attrs = { colspan: 2 };
    }],
    ["rowspan", (table: PmTableNode) => {
      table.content[0]!.content[0]!.attrs = { rowspan: 2 };
    }],
    ["colwidth", (table: PmTableNode) => {
      table.content[0]!.content[0]!.attrs = { colwidth: [120] };
    }],
    ["嵌套结构", (table: PmTableNode) => {
      table.content[0]!.content[0]!.content.push({
        type: "paragraph",
        attrs: { blockId: "outside-extra" },
        content: [{ type: "text", text: "新增结构" }],
      });
    }],
    ["cell 类型", (table: PmTableNode) => {
      table.content[0]!.content[0]!.type = "tableHeader";
    }],
  ] as const)("未选行 %s 变化仍拒绝", (_name, mutate) => {
    const before = tableDoc().content[0] as PmTableNode;
    const after = clonePmDoc(tableDoc()).content[0] as PmTableNode;
    mutate(after);

    expect(validateTableSelectionScope({
      before,
      after,
      tableRef: "table-1",
      selection: { axis: "row", startIndex: 1, endIndex: 1 },
    })).toMatchObject({ ok: false, rowIndex: 0, columnIndex: 0 });
  });

  it("未选行 diagram 仅 source 变化仍拒绝", () => {
    const before = tableDoc().content[0] as PmTableNode;
    before.content[0]!.content[0]!.content.push({
      type: "diagram",
      attrs: {
        blockId: "diagram-before",
        lang: "mermaid",
        source: "flowchart LR\nA --> B",
        svg: "<svg>旧缓存</svg>",
      },
    });
    const after = clonePmDoc({ type: "doc", attrs: { schemaVersion: 1 }, content: [before] }).content[0] as PmTableNode;
    const diagram = after.content[0]!.content[0]!.content[1] as any;
    diagram.attrs.blockId = "diagram-after";
    diagram.attrs.source = "flowchart LR\nA --> C";
    diagram.attrs.svg = "<svg>新缓存</svg>";

    expect(validateTableSelectionScope({
      before,
      after,
      tableRef: "table-1",
      selection: { axis: "row", startIndex: 1, endIndex: 1 },
    })).toMatchObject({ ok: false, rowIndex: 0, columnIndex: 0 });
  });

  it("选中行内文本、marks、attrs 与结构变化均放行", () => {
    const before = tableDoc().content[0] as PmTableNode;
    const after = clonePmDoc(tableDoc()).content[0] as PmTableNode;
    const selectedCell = after.content[1]!.content[0]!;
    selectedCell.attrs = { colspan: 2, colwidth: [90, 110], backgroundColor: "amber" };
    (selectedCell.content[0] as any).content[0] = { type: "text", text: "范围内", marks: [{ type: "bold" }] };
    selectedCell.content.push({
      type: "paragraph",
      attrs: { blockId: "selected-extra" },
      content: [{ type: "text", text: "新增结构" }],
    });

    expect(validateTableSelectionScope({
      before,
      after,
      tableRef: "table-1",
      selection: { axis: "row", startIndex: 1, endIndex: 1 },
    })).toEqual({ ok: true });
  });

  it("行轴选区内增删行按前后缀对齐放行，表尾未选区加行仍拒绝", () => {
    const before = tableDocFromRows([
      ["前缀A", "前缀B"],
      ["选中1A", "选中1B"],
      ["选中2A", "选中2B"],
      ["后缀A", "后缀B"],
    ]).content[0] as PmTableNode;
    const inserted = clonePmDoc({ type: "doc", attrs: { schemaVersion: 1 }, content: [before] }).content[0] as PmTableNode;
    const replacementRows = (tableDocFromRows([
      ["新增1A", "新增1B"],
      ["新增2A", "新增2B"],
      ["新增3A", "新增3B"],
    ]).content[0] as PmTableNode).content;
    inserted.content.splice(1, 2, ...replacementRows);
    expect(validateTableSelectionScope({
      before,
      after: inserted,
      tableRef: "table-1",
      selection: { axis: "row", startIndex: 1, endIndex: 2 },
    })).toEqual({ ok: true });

    const deleted = clonePmDoc({ type: "doc", attrs: { schemaVersion: 1 }, content: [before] }).content[0] as PmTableNode;
    deleted.content.splice(1, 2);
    expect(validateTableSelectionScope({
      before,
      after: deleted,
      tableRef: "table-1",
      selection: { axis: "row", startIndex: 1, endIndex: 2 },
    })).toEqual({ ok: true });

    const appended = clonePmDoc({ type: "doc", attrs: { schemaVersion: 1 }, content: [before] }).content[0] as PmTableNode;
    appended.content.push((tableDocFromRows([["越界A", "越界B"]]).content[0] as PmTableNode).content[0]!);
    expect(validateTableSelectionScope({
      before,
      after: appended,
      tableRef: "table-1",
      selection: { axis: "row", startIndex: 1, endIndex: 2 },
    })).toMatchObject({ ok: false, rowIndex: 3, columnIndex: 0 });
  });

  it("纯函数拒绝未选列 attrs 变化，放行选中列变化", () => {
    const before = tableDoc().content[0] as PmTableNode;
    const outside = clonePmDoc(tableDoc()).content[0] as PmTableNode;
    outside.content[0]!.content[1]!.attrs = { backgroundColor: "amber" };
    const rejected = validateTableSelectionScope({
      before,
      after: outside,
      tableRef: "table-1",
      selection: { axis: "column", startIndex: 0, endIndex: 0 },
    });
    expect(rejected).toMatchObject({ ok: false, rowIndex: 0, columnIndex: 1 });
    if (!rejected.ok) expect(rejected.error).toContain("row=0, column=1");

    const inside = clonePmDoc(tableDoc()).content[0] as PmTableNode;
    inside.content[0]!.content[0]!.attrs = { backgroundColor: "amber" };
    expect(validateTableSelectionScope({
      before,
      after: inside,
      tableRef: "table-1",
      selection: { axis: "column", startIndex: 0, endIndex: 0 },
    })).toEqual({ ok: true });
  });

  it("拒绝未选单元格 mark 变化", () => {
    const before = tableDoc().content[0] as PmTableNode;
    const after = clonePmDoc(tableDoc()).content[0] as PmTableNode;
    const text = (after.content[0]!.content[1]!.content[0] as any).content[0] as {
      marks?: Array<{ type: string }>;
    };
    text.marks = [{ type: "bold" }];

    expect(validateTableSelectionScope({
      before,
      after,
      tableRef: "table-1",
      selection: { axis: "column", startIndex: 0, endIndex: 0 },
    })).toMatchObject({ ok: false, rowIndex: 0, columnIndex: 1 });
  });

  it("含 colspan/rowspan 时按逻辑格比较，跨格占位与起点视为同一 cell", () => {
    const before = clonePmDoc(tableDoc()).content[0] as PmTableNode;
    before.content = [
      { type: "tableRow", content: [
        { ...before.content[0]!.content[0]!, attrs: { colspan: 2, rowspan: 2 } },
        before.content[0]!.content[1]!,
      ] },
      { type: "tableRow", content: [before.content[1]!.content[1]!] },
    ];
    const selected = clonePmDoc({ type: "doc", attrs: { schemaVersion: 1 }, content: [before] }).content[0] as PmTableNode;
    selected.content[0]!.content[0]!.attrs = { ...selected.content[0]!.content[0]!.attrs, backgroundColor: "amber" };
    expect(validateTableSelectionScope({
      before,
      after: selected,
      tableRef: "table-1",
      selection: { axis: "column", startIndex: 0, endIndex: 1 },
    })).toEqual({ ok: true });
    expect(validateTableSelectionScope({
      before,
      after: selected,
      tableRef: "table-1",
      selection: { axis: "column", startIndex: 0, endIndex: 0 },
    })).toEqual({ ok: true });

    const outside = clonePmDoc({ type: "doc", attrs: { schemaVersion: 1 }, content: [before] }).content[0] as PmTableNode;
    outside.content[0]!.content[1]!.attrs = { backgroundColor: "amber" };
    expect(validateTableSelectionScope({
      before,
      after: outside,
      tableRef: "table-1",
      selection: { axis: "column", startIndex: 0, endIndex: 1 },
    })).toMatchObject({ ok: false, rowIndex: 0, columnIndex: 2 });
  });

  it("服务端拒绝表外块变化与编辑前目标表缺失", () => {
    const state = bindTableSelection("row", 0, 0);
    const before = tableDoc();
    const after = clonePmDoc(before);
    after.content.push({
      type: "paragraph",
      attrs: { blockId: "outside" },
      content: [{ type: "text", text: "越界" }],
    });
    expect(validateCurrentTableSelectionScopes(state, before, after)).toMatchObject({
      ok: false,
      error: expect.stringContaining("目标表外"),
    });

    const outsideIdChanged = clonePmDoc(before);
    outsideIdChanged.content.push({
      type: "paragraph",
      attrs: { blockId: "outside-new-id" },
      content: [{ type: "text", text: "原文" }],
    });
    const beforeWithOutside = clonePmDoc(before);
    beforeWithOutside.content.push({
      type: "paragraph",
      attrs: { blockId: "outside-old-id" },
      content: [{ type: "text", text: "原文" }],
    });
    expect(validateCurrentTableSelectionScopes(state, beforeWithOutside, outsideIdChanged)).toMatchObject({
      ok: false,
      error: expect.stringContaining("目标表外"),
    });

    const missing = clonePmDoc(before);
    missing.content = [];
    expect(validateCurrentTableSelectionScopes(state, missing, missing)).toMatchObject({
      ok: false,
      error: expect.stringContaining("编辑前已不存在"),
    });
  });

  it("表格选区轮不注入可绕过审计的 writeDraft", () => {
    const tools = createSessionScopedTools(bindTableSelection("row", 0, 0));
    expect("writeDraft" in tools).toBe(false);
  });

  it("editDraft 拒绝选中行外文本变化并保持候选未改", async () => {
    const state = bindTableSelection("row", 0, 0);
    const { editDraft } = createSessionScopedTools(state);
    const result = await editDraft.execute!({
      ops: [{ action: "replaceText", withinRef: "table-1", find: "B2", replace: "越界" }],
    }, ctx) as any;

    expect(result.ok).toBe(false);
    expect(result.failedOpIndex).toBe(0);
    expect(result.error).toContain("表格选区越界");
    expect(result.error).toContain("row=1, column=1");
    expect(pmTableSelectionCellTexts(state.docDraftCandidateDoc!, "table-1", {
      axis: "row",
      startIndex: 1,
      endIndex: 1,
    })).toEqual(["A2", "B2"]);
  });

  it("editDraft 放行选中行内文本变化", async () => {
    const state = bindTableSelection("row", 0, 0);
    const { editDraft } = createSessionScopedTools(state);
    const result = await editDraft.execute!({
      ops: [{ action: "replaceText", withinRef: "table-1", find: "B1", replace: "范围内" }],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    expect(pmTableSelectionCellTexts(state.docDraftCandidateDoc!, "table-1", {
      axis: "row",
      startIndex: 0,
      endIndex: 0,
    })).toEqual(["A1", "范围内"]);
  });

  it("端到端 editDraft replaceBlock 重建整表时放行等价未选行并落地选中行", async () => {
    const state = bindTableSelection("row", 1, 1);
    const { editDraft } = createSessionScopedTools(state);
    const result = await editDraft.execute!({
      ops: [{
        action: "replaceBlock",
        ref: "table-1",
        block: "<table><tr><td><p>A1</p></td><td><p>B1</p></td></tr><tr><td><p>一二三</p></td><td><p>B2</p></td></tr></table>",
      }],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    expect(pmTableSelectionCellTexts(state.docDraftCandidateDoc!, "table-1", {
      axis: "row",
      startIndex: 0,
      endIndex: 0,
    })).toEqual(["A1", "B1"]);
    expect(pmTableSelectionCellTexts(state.docDraftCandidateDoc!, "table-1", {
      axis: "row",
      startIndex: 1,
      endIndex: 1,
    })).toEqual(["一二三", "B2"]);
    const rebuiltTable = state.docDraftCandidateDoc!.content[0] as PmTableNode;
    expect(rebuiltTable.content[0]!.content[0]!.content[0]!.attrs?.blockId).not.toBe("p-r1-c1");
  });

  it("editDraft 拒绝表外段落变化并保持候选未改", async () => {
    const state = bindTableSelection("row", 0, 0);
    state.doc!.content.push({
      type: "paragraph",
      attrs: { blockId: "outside" },
      content: [{ type: "text", text: "原文" }],
    });
    const { editDraft } = createSessionScopedTools(state);
    const result = await editDraft.execute!({
      ops: [{ action: "replaceText", withinRef: "outside", find: "原文", replace: "越界" }],
    }, ctx) as any;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("目标表外");
    expect(state.docDraftCandidateDoc?.content[1]).toMatchObject({
      content: [{ text: "原文" }],
    });
  });
});
