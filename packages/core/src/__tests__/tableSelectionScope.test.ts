import { describe, expect, it } from "vitest";
import { pmTableSelectionCellTexts, pmToLegacySections, type PmDoc, type PmTableNode } from "@qingagent/pm-schema";
import { createSession } from "../bridge/sessionState.js";
import { createSessionScopedTools } from "../bridge/sessionTools.js";
import { clonePmDoc, validateCurrentTableSelectionScopes, validateTableSelectionScope } from "../bridge/draftScratch.js";

const ctx = {} as any;

function tableDoc(): PmDoc {
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
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [paragraph("p-a1", "A1")] },
            { type: "tableCell", content: [paragraph("p-b1", "B1")] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [paragraph("p-a2", "A2")] },
            { type: "tableCell", content: [paragraph("p-b2", "B2")] },
          ],
        },
      ],
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
  state.legacySections = pmToLegacySections(state.doc) as any;
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

  it("editDraft 拒绝表外段落变化并保持候选未改", async () => {
    const state = bindTableSelection("row", 0, 0);
    state.doc!.content.push({
      type: "paragraph",
      attrs: { blockId: "outside" },
      content: [{ type: "text", text: "原文" }],
    });
    state.legacySections = pmToLegacySections(state.doc!) as any;
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
